import { requireAgent } from "./auth";
import { CheckRuleError, assertCheckFits, rulesFor, type PieceRules } from "./check-rules";
import { CHECKING_ID, LIMITS, PROJECT_ID, type AppEnv } from "./config";
import { randomHex, signPreview } from "./crypto";
import { HttpError, json, readJson, readOptionalJson } from "./http";
import { PlainDataError, assertPlainData, describeForDisplay } from "./plain-data";
import { audit, getSettings, iso, nextDayStart, utcDay } from "./store";
import { checkModelName } from "./text-safety";
import type { TestCase } from "./work";
import { reopenPiece } from "./work-admin";

/**
 * Checking work. An agent is handed the task of a piece that is already built
 * (never one it built itself) and proposes extra checks: inputs, each with
 * the answer the agent expects from reading the task. It never sees the built
 * code, the answer key, or what either returns.
 *
 * The checks are run later in the sealed box the admin page opens, against
 * the built piece and the answer key. Three parties then have a view on each
 * input: the built piece, the answer key, and the checking agent. The verdict
 * is whatever two of them agree on:
 *
 *   agreed        all three agree. The piece held up.
 *   not_expected  piece and key agree, the agent expected something else.
 *   fault         key and agent agree, the piece differs. The piece is wrong.
 *   key_question  piece and agent agree, the key differs. The key may be wrong.
 *   unclear       no two agree, or the key could not answer. Not counted.
 *
 * Only "fault" and "key_question" need a person. Everything else settles itself.
 */

export const VERDICTS = ["agreed", "not_expected", "fault", "key_question", "unclear"] as const;
export type Verdict = (typeof VERDICTS)[number];

export interface ProposedCheck {
  call: string;
  args: unknown[];
  expect: unknown;
}

interface StoredResult {
  verdict: Verdict;
  /** What the built piece and the answer key returned, cut down for display. Kept only for findings. */
  piece?: string;
  key?: string;
  /** The piece gave no answer: it hung, crashed, or answered differently the second time. */
  piece_stopped?: boolean;
}

type CheckingStatus = "claimed" | "submitted" | "clear" | "flagged" | "closed";

interface CheckingRow {
  id: string;
  work_id: string;
  piece_id: string;
  piece_title: string;
  project_id: string;
  project_title: string;
  status: CheckingStatus;
  checks: string;
  results: string;
  agreed: number;
  faults: number;
  questions: number;
  resolution: string;
  claimed_at: number;
  expires_at: number;
  /** The piece still runs on the code this task was handed out for. */
  current: number;
}

const COLUMNS = `k.id, k.work_id, k.piece_id, p.title AS piece_title, k.project_id, j.title AS project_title, k.status, k.checks,
  k.results, k.agreed, k.faults, k.questions, k.resolution, k.claimed_at, k.expires_at, (p.accepted_work_id = k.work_id) AS current`;
const FROM = "FROM checking k JOIN pieces p ON p.id = k.piece_id JOIN projects j ON j.id = k.project_id";

/** How many checking tasks of one project the agent has taken on this day. */
const takenToday = (agent: string, project: string, day: string) =>
  `(SELECT COUNT(*) FROM checking d WHERE d.agent_id = ${agent} AND d.project_id = ${project} AND d.day = ${day})`;

/** Whether piece p could be handed to this agent for checking, leaving the daily limit aside. */
const checkable = (agent: string) =>
  `(p.accepted_work_id IS NOT NULL AND p.check_calls <> '{}' AND p.reference_code <> ''
    AND (SELECT w.agent_id FROM work w WHERE w.id = p.accepted_work_id) <> ${agent}
    AND NOT EXISTS (SELECT 1 FROM checking mine WHERE mine.work_id = p.accepted_work_id AND mine.agent_id = ${agent})
    AND (SELECT COUNT(*) FROM checking every WHERE every.work_id = p.accepted_work_id) < ${LIMITS.checkersPerWork})`;

/** A checking task the agent holds and can still hand in. An agent holds one at a time. */
const inHand = (agent: string, ts: string) =>
  `EXISTS (SELECT 1 FROM checking h WHERE h.agent_id = ${agent} AND h.status = 'claimed' AND h.expires_at > ${ts})`;

interface AgentProject {
  id: string;
  title: string;
  taken_today: number;
  available: number;
}

async function agentProjects(db: D1Database, agentId: string, ts: number): Promise<AgentProject[]> {
  const { results } = await db
    .prepare(
      `SELECT j.id, j.title, ${takenToday("?1", "j.id", "?2")} AS taken_today,
         EXISTS (SELECT 1 FROM pieces p WHERE p.project_id = j.id AND ${checkable("?1")}) AS available
       FROM projects j ORDER BY j.position, j.id`,
    )
    .bind(agentId, utcDay(ts))
    .all<AgentProject>();
  return results;
}

const tasksLeft = (project: AgentProject) => Math.max(0, LIMITS.checkingPerAgentPerProjectPerDay - project.taken_today);
const canTakeFrom = (project: AgentProject) => project.available === 1 && tasksLeft(project) > 0;

async function latest(db: D1Database, agentId: string): Promise<CheckingRow | null> {
  return db
    .prepare(`SELECT ${COLUMNS} ${FROM} WHERE k.agent_id = ? ORDER BY k.claimed_at DESC, k.rowid DESC LIMIT 1`)
    .bind(agentId)
    .first<CheckingRow>();
}

const holds = (row: CheckingRow | null, ts: number): row is CheckingRow => row !== null && row.status === "claimed" && row.expires_at > ts;

/** What checking work has for this agent right now, for the "today" summary a returning agent reads. */
export async function checkingToday(env: AppEnv, agentId: string, ts: number): Promise<{ checking_to_hand_in: boolean; can_take_checking: boolean }> {
  const toHandIn = holds(await latest(env.DB, agentId), ts);
  if (toHandIn || !(await getSettings(env.DB)).checking_open) return { checking_to_hand_in: toHandIn, can_take_checking: false };
  return { checking_to_hand_in: false, can_take_checking: (await agentProjects(env.DB, agentId, ts)).some(canTakeFrom) };
}

const WORDS: Record<Verdict, string> = {
  agreed: "held: the built piece gave the answer you expected",
  not_expected: "not counted: your expected answer is not what the answer key gives",
  fault: "fault found: the built piece is wrong on this input",
  key_question: "under review: you and the built piece agree, and the answer key does not",
  unclear: "not counted: the built piece, the answer key and your expected answer all differ, or the answer key could not answer",
};

function describe(row: CheckingRow, ts: number) {
  const ran = row.status === "clear" || row.status === "flagged" || (row.status === "closed" && row.results !== "[]");
  const results = ran ? (JSON.parse(row.results) as StoredResult[]) : [];
  return {
    id: row.id,
    project: { id: row.project_id, title: row.project_title },
    piece: { id: row.piece_id, title: row.piece_title },
    status:
      row.status === "claimed"
        ? row.expires_at > ts
          ? "claimed"
          : "expired"
        : row.status === "submitted"
          ? "waiting to be run"
          : ran
            ? "run"
            : row.resolution === "not_run"
              ? "closed without being run"
              : "closed before it was run: the piece changed",
    hand_in_by: row.status === "claimed" ? iso(row.expires_at) : null,
    // One line per check, in the order sent. Never what the piece or the answer key returned.
    results: ran ? results.map((result, index) => ({ check: index, outcome: WORDS[result.verdict] })) : null,
    summary: ran ? { checks: results.length, held: row.agreed, faults_found: row.faults, under_review: row.questions } : null,
  };
}

async function taskReply(env: AppEnv, row: CheckingRow) {
  const piece = await env.DB
    .prepare("SELECT spec, public_tests, check_calls FROM pieces WHERE id = ?")
    .bind(row.piece_id)
    .first<{ spec: string; public_tests: string; check_calls: string }>();
  if (!piece) throw new HttpError(404, "not_found", "No such piece.");
  return {
    task: piece.spec,
    examples: JSON.parse(piece.public_tests) as unknown,
    functions_you_may_check: Object.keys(JSON.parse(piece.check_calls) as Record<string, number>).sort(),
    what_to_do:
      "This piece is already built. The task above is what its builder was given. Do not write the piece. " +
      "Look for inputs the builder may have got wrong: edges, limits, unusual but allowed cases. " +
      "For each, work out from the task what the right answer is.",
    how_to_hand_in:
      `POST ${env.GALLERY_ORIGIN}/api/v1/checking/submit with {"checks": [{"call": "name", "args": [...], "expect": ...}], "model": "..."} ("model" is optional). ` +
      `1 to ${LIMITS.checksPerTask} different checks. "call" is one of functions_you_may_check, "args" is the list of arguments, "expect" is the answer the task says is right. ` +
      "A check must look like the task's own examples: the same number and kinds of arguments, the same field names, numbers of a similar size, " +
      "and no text other than names the task itself uses. Do not repeat an example. Stay inside what the task allows as input. You get one hand-in per task.",
    about_this_task:
      "The task text was written by the site's operator. Your checks are run later against the built piece and the answer key. " +
      "You are never shown the built code, the answer key, or what either returns.",
  };
}

type ClaimResult = { outcome: "claimed"; id: string } | { outcome: "in_hand" } | { outcome: "daily_limit" } | { outcome: "none_available" };

/**
 * Hands the agent one built piece to check, from the named project or from
 * any, favouring the pieces checked least. One statement, so simultaneous
 * requests cannot slip past the daily limit or the one-in-hand rule.
 */
async function claimChecking(db: D1Database, agentId: string, projectId: string | null, ts: number): Promise<ClaimResult> {
  const id = "k_" + randomHex(12);
  const result = await db
    .prepare(
      `INSERT INTO checking (id, work_id, piece_id, project_id, agent_id, day, slot, status, claimed_at, expires_at)
       SELECT ?1, p.accepted_work_id, p.id, p.project_id, ?2, ?3, ${takenToday("?2", "p.project_id", "?3")} + 1, 'claimed', ?4, ?5
       FROM pieces p
       WHERE ${checkable("?2")}
         AND (?6 IS NULL OR p.project_id = ?6)
         AND ${takenToday("?2", "p.project_id", "?3")} < ?7
         AND NOT ${inHand("?2", "?4")}
         AND (SELECT status FROM agents WHERE id = ?2) = 'active'
       ORDER BY (SELECT COUNT(*) FROM checking x WHERE x.work_id = p.accepted_work_id) ASC, RANDOM()
       LIMIT 1
       ON CONFLICT DO NOTHING`,
    )
    .bind(id, agentId, utcDay(ts), ts, ts + LIMITS.workClaimSeconds, projectId, LIMITS.checkingPerAgentPerProjectPerDay)
    .run();
  if (result.meta.changes === 1) return { outcome: "claimed", id };
  if (await db.prepare(`SELECT 1 AS x WHERE ${inHand("?1", "?2")}`).bind(agentId, ts).first()) return { outcome: "in_hand" };
  const scope = (await agentProjects(db, agentId, ts)).filter((project) => projectId === null || project.id === projectId);
  return scope.some((project) => project.available === 1 && tasksLeft(project) === 0) ? { outcome: "daily_limit" } : { outcome: "none_available" };
}

async function byId(db: D1Database, id: string): Promise<CheckingRow | null> {
  return db.prepare(`SELECT ${COLUMNS} ${FROM} WHERE k.id = ?`).bind(id).first<CheckingRow>();
}

async function claim(request: Request, env: AppEnv, ts: number): Promise<Response> {
  const agent = await requireAgent(request, env, ts);
  if (!(await getSettings(env.DB)).checking_open) {
    throw new HttpError(503, "checking_closed", "Checking work is not being handed out right now. Do not retry automatically.");
  }
  const body = await readOptionalJson(request, LIMITS.smallRequestMaxBytes);
  let projectId: string | null = null;
  if (body.project !== undefined && body.project !== null) {
    if (typeof body.project !== "string" || !new RegExp(`^${PROJECT_ID}$`).test(body.project)) {
      throw new HttpError(400, "invalid_project", '"project" must be the id of a project, or left out.', { field: "project" });
    }
    projectId = body.project;
    if (!(await env.DB.prepare("SELECT 1 AS x FROM projects WHERE id = ?").bind(projectId).first())) {
      throw new HttpError(404, "not_found", "No such project. GET /api/v1/projects lists them.");
    }
  }
  const result = await claimChecking(env.DB, agent.id, projectId, ts);
  if (result.outcome === "in_hand") {
    throw new HttpError(409, "checking_in_hand", "Hand in the checking task you already hold before taking another. GET /api/v1/checking shows it.");
  }
  if (result.outcome === "daily_limit") {
    const next = nextDayStart(ts);
    throw new HttpError(
      429,
      "daily_limit",
      `This agent has taken all the checking tasks it may today: ${LIMITS.checkingPerAgentPerProjectPerDay} per project per UTC day.`,
      { retry_at: iso(next) },
      { "Retry-After": String(next - ts) },
    );
  }
  if (result.outcome === "none_available") {
    throw new HttpError(409, "nothing_available", "There is no built piece for this agent to check right now. Do not retry today.");
  }
  const row = await byId(env.DB, result.id);
  if (!row) throw new HttpError(500, "internal_error", "Something went wrong on our side.");
  return json({ checking: describe(row, ts), ...(await taskReply(env, row)) }, 201);
}

async function status(request: Request, env: AppEnv, ts: number): Promise<Response> {
  const agent = await requireAgent(request, env, ts);
  const [row, projects, settings] = await Promise.all([latest(env.DB, agent.id), agentProjects(env.DB, agent.id, ts), getSettings(env.DB)]);
  const holding = holds(row, ts);
  return json({
    checking: row ? describe(row, ts) : null,
    can_take_checking_now: !holding && settings.checking_open && projects.some(canTakeFrom),
    projects: projects.map((project) => ({
      id: project.id,
      title: project.title,
      checking_tasks_left_today: tasksLeft(project),
      has_a_piece_for_you_to_check: project.available === 1,
    })),
    ...(holding ? await taskReply(env, row) : {}),
  });
}

/** Checks one proposed check and returns it in the exact form it is stored and run in. */
function parseCheck(raw: unknown, index: number, rules: PieceRules): ProposedCheck {
  const invalid = (message: string) => new HttpError(400, "invalid_checks", `Check ${index}: ${message} Nothing was handed in; fix it and send again.`, { field: "checks" });
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalid('must be an object with "call", "args" and "expect".');
  const { call, args, expect } = raw as Record<string, unknown>;
  if (typeof call !== "string" || !rules.calls.has(call)) throw invalid(`"call" must be one of: ${[...rules.calls.keys()].sort().join(", ")}.`);
  if (!Array.isArray(args)) throw invalid('"args" must be the list of arguments.');
  if (expect === undefined) throw invalid('"expect" is missing. Give the answer the task says is right; use null if that is the answer.');
  const check = { call, args, expect };
  try {
    assertPlainData(args);
    assertPlainData(expect);
    assertCheckFits(check, rules);
  } catch (err) {
    if (err instanceof PlainDataError) throw invalid(`it ${err.message}.`);
    if (err instanceof CheckRuleError) throw invalid(`${err.message}.`);
    throw err;
  }
  if (new TextEncoder().encode(JSON.stringify(check)).byteLength > LIMITS.checkMaxBytes) {
    throw invalid(`is larger than ${LIMITS.checkMaxBytes} bytes when written out.`);
  }
  return check;
}

async function submit(request: Request, env: AppEnv, ts: number): Promise<Response> {
  const agent = await requireAgent(request, env, ts);
  const row = await latest(env.DB, agent.id);
  if (!row || row.status !== "claimed") throw new HttpError(409, "nothing_to_hand_in", "This agent has no checking task waiting to be handed in.");
  if (row.expires_at <= ts) throw new HttpError(409, "expired", "The time to hand in this checking task has passed.");
  const body = await readJson(request, LIMITS.checkingRequestMaxBytes);
  const model = checkModelName(body.model);
  if (!Array.isArray(body.checks) || body.checks.length < 1 || body.checks.length > LIMITS.checksPerTask) {
    throw new HttpError(400, "invalid_checks", `"checks" must be a list of 1 to ${LIMITS.checksPerTask} checks. Nothing was handed in.`, { field: "checks" });
  }
  const piece = await env.DB
    .prepare("SELECT public_tests, hidden_tests FROM pieces WHERE id = ?")
    .bind(row.piece_id)
    .first<{ public_tests: string; hidden_tests: string }>();
  if (!piece) throw new HttpError(404, "not_found", "No such piece.");
  const rules = rulesFor(JSON.parse(piece.public_tests) as TestCase[], JSON.parse(piece.hidden_tests) as TestCase[]);
  const checks = body.checks.map((raw, index) => parseCheck(raw, index, rules));
  const written = checks.map((check) => JSON.stringify([check.call, check.args]));
  const repeat = written.findIndex((entry, index) => written.indexOf(entry) !== index);
  if (repeat !== -1) {
    throw new HttpError(400, "invalid_checks", `Check ${repeat} repeats an earlier check. Send each input once. Nothing was handed in.`, { field: "checks" });
  }

  const updated = await env.DB
    .prepare(
      `UPDATE checking SET status = 'submitted', model = ?, checks = ?, submitted_at = ?
       WHERE id = ? AND agent_id = ? AND status = 'claimed' AND expires_at > ?
         AND (SELECT status FROM agents WHERE id = ?) = 'active'`,
    )
    .bind(model, JSON.stringify(checks), ts, row.id, agent.id, ts, agent.id)
    .run();
  if (updated.meta.changes !== 1) throw new HttpError(409, "nothing_to_hand_in", "This checking task was already handed in, or the piece changed.");
  const after = await byId(env.DB, row.id);
  return json(
    {
      checking: after ? describe(after, ts) : { id: row.id },
      what_happens_next:
        "Your checks will be run against the built piece and the answer key the next time the site's operator opens the review page. " +
        "Do not poll for the result. GET /api/v1/checking shows it later, and whether you may take another task today.",
    },
    201,
  );
}

/** Routes under /api/v1/checking. Returns null when the path is not one of them. */
export async function handleCheckingApi(request: Request, env: AppEnv, url: URL, ts: number): Promise<Response | null> {
  const { pathname } = url;
  const method = request.method;
  if (pathname === "/api/v1/checking" && method === "GET") return status(request, env, ts);
  if (pathname === "/api/v1/checking/claim" && method === "POST") return claim(request, env, ts);
  if (pathname === "/api/v1/checking/submit" && method === "POST") return submit(request, env, ts);
  return null;
}

// ------------------------------------------------- what the sandbox host needs

/** Everything needed to run one checking task. Includes the answer key: admin only. */
export async function checkingForRun(db: D1Database, id: string) {
  const row = await db
    .prepare(
      `SELECT k.id, k.checks, p.title, p.check_calls, p.reference_code, c.code
       FROM checking k JOIN pieces p ON p.id = k.piece_id JOIN work_code c ON c.work_id = k.work_id
       WHERE k.id = ? AND k.status = 'submitted' AND p.accepted_work_id = k.work_id`,
    )
    .bind(id)
    .first<{ id: string; checks: string; title: string; check_calls: string; reference_code: string; code: string }>();
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    code: row.code,
    key: row.reference_code,
    checks: JSON.parse(row.checks) as ProposedCheck[],
    tolerances: JSON.parse(row.check_calls) as Record<string, number>,
  };
}

// ----------------------------------------------------------------- admin side

const ADMIN_COLUMNS = `k.id, k.piece_id, p.title AS piece_title, j.title AS project_title, k.agent_id, a.name AS agent_name, k.model,
  k.checks, k.results, k.submitted_at, (p.accepted_work_id = k.work_id) AS current`;
const ADMIN_FROM = `${FROM} JOIN agents a ON a.id = k.agent_id`;

interface AdminRow {
  id: string;
  piece_id: string;
  piece_title: string;
  project_title: string;
  agent_id: string;
  agent_name: string;
  model: string;
  checks: string;
  results: string;
  submitted_at: number;
  current: number;
  check_count?: number;
}

/** The checking part of the admin overview. */
export async function checkingOverview(env: AppEnv, ts: number) {
  const [waiting, flagged, totals] = await env.DB.batch([
    // The waiting list needs only how many checks each task holds, not the checks themselves.
    env.DB.prepare(
      `SELECT ${ADMIN_COLUMNS.replace("k.checks, k.results", "json_array_length(k.checks) AS check_count, '' AS checks, '' AS results")} ${ADMIN_FROM}
       WHERE k.status = 'submitted' AND p.accepted_work_id = k.work_id ORDER BY k.submitted_at LIMIT 20`,
    ),
    env.DB.prepare(`SELECT ${ADMIN_COLUMNS} ${ADMIN_FROM} WHERE k.status = 'flagged' ORDER BY k.submitted_at LIMIT 20`),
    env.DB.prepare(
      `SELECT COUNT(*) AS tasks, COALESCE(SUM(agreed), 0) AS held, COALESCE(SUM(faults), 0) AS faults
       FROM checking WHERE status IN ('clear', 'flagged', 'closed') AND results <> '[]'`,
    ),
  ]);
  const base = (row: AdminRow) => ({
    id: row.id,
    piece_id: row.piece_id,
    piece_title: row.piece_title,
    project_title: row.project_title,
    agent_id: row.agent_id,
    agent_name: row.agent_name,
    model: row.model,
    submitted_at: iso(row.submitted_at),
  });
  return {
    totals: (totals?.results[0] as { tasks: number; held: number; faults: number } | undefined) ?? { tasks: 0, held: 0, faults: 0 },
    waiting: await Promise.all(
      ((waiting?.results ?? []) as AdminRow[]).map(async (row) => ({
        ...base(row),
        checks: row.check_count ?? 0,
        // Opens the task in the sandbox, where the checks run.
        frame_url: `${env.SANDBOX_ORIGIN}/c/${row.id}?p=${await signPreview(env, row.id, ts + LIMITS.previewSeconds)}`,
      })),
    ),
    flagged: ((flagged?.results ?? []) as AdminRow[]).map((row) => {
      const checks = JSON.parse(row.checks) as ProposedCheck[];
      const results = JSON.parse(row.results) as StoredResult[];
      return {
        ...base(row),
        piece_still_built: row.current === 1,
        findings: results
          .map((result, index) => ({ result, check: checks[index]! }))
          .filter(({ result }) => result.verdict === "fault" || result.verdict === "key_question")
          .map(({ result, check }) => ({
            kind: result.verdict,
            call: check.call,
            // Shown whole: a check is small, and a person deciding on it must see all of the input.
            args: JSON.stringify(check.args),
            agent_expected: describeForDisplay(check.expect),
            piece_stopped: result.piece_stopped === true,
            piece_gave: result.piece_stopped ? "" : (result.piece ?? ""),
            key_gives: result.key ?? "",
          })),
      };
    }),
  };
}

/** Stores what the sealed box worked out for one checking task. */
async function record(env: AppEnv, id: string, body: Record<string, unknown>, ts: number): Promise<Response> {
  const row = await byId(env.DB, id);
  if (!row || row.status !== "submitted") throw new HttpError(409, "wrong_state", "That checking task is not waiting to be run.");
  const checks = JSON.parse(row.checks) as ProposedCheck[];
  if (!Array.isArray(body.results) || body.results.length !== checks.length) {
    throw new HttpError(400, "invalid_result", `"results" must have one entry for each of the ${checks.length} checks.`);
  }
  const results: StoredResult[] = (body.results as Record<string, unknown>[]).map((raw) => {
    const verdict = raw?.verdict as Verdict;
    if (!VERDICTS.includes(verdict)) throw new HttpError(400, "invalid_result", "Unknown verdict.");
    const finding = verdict === "fault" || verdict === "key_question";
    // What agent-written code returned is never stored or shown as it came.
    if (!finding) return { verdict };
    const stopped = raw.piece_stopped === true;
    return { verdict, piece_stopped: stopped, piece: stopped ? "" : describeForDisplay(raw.piece), key: describeForDisplay(raw.key) };
  });
  const count = (verdict: Verdict) => results.filter((result) => result.verdict === verdict).length;
  const flagged = count("fault") + count("key_question") > 0;
  const updated = await env.DB
    .prepare(
      `UPDATE checking SET status = ?, results = ?, agreed = ?, faults = ?, questions = ?, decided_at = ?
       WHERE id = ? AND status = 'submitted'`,
    )
    .bind(flagged ? "flagged" : "clear", JSON.stringify(results), count("agreed"), count("fault"), count("key_question"), ts, id)
    .run();
  if (updated.meta.changes !== 1) throw new HttpError(409, "wrong_state", "That checking task is not waiting to be run.");
  await audit(env.DB, "admin", "checking_run", id, `${count("agreed")} held, ${count("fault")} faults, ${count("key_question")} questions`, ts);
  return json({ ok: true, status: flagged ? "flagged" : "clear" });
}

/** Closes a task that is waiting to be run, without running it. For one that cannot be run or should not be. */
async function closeWaiting(env: AppEnv, id: string, ts: number): Promise<Response> {
  const closed = await env.DB
    .prepare("UPDATE checking SET status = 'closed', resolution = 'not_run', decided_at = ? WHERE id = ? AND status = 'submitted'")
    .bind(ts, id)
    .run();
  if (closed.meta.changes !== 1) throw new HttpError(409, "wrong_state", "That checking task is not waiting to be run.");
  await audit(env.DB, "admin", "checking_close", id, "", ts);
  return json({ ok: true });
}

async function settle(env: AppEnv, id: string, action: string, ts: number): Promise<Response> {
  const row = await byId(env.DB, id);
  if (!row || row.status !== "flagged") throw new HttpError(409, "wrong_state", "That checking task has nothing waiting for a decision.");
  if (action === "reopen_piece") {
    if (row.faults === 0) throw new HttpError(409, "no_fault", "A piece is only thrown out for a fault: the answer key and the checking agent agreeing against it.");
    if (row.current !== 1) throw new HttpError(409, "piece_changed", "That piece has already been thrown out or built again.");
    // Closes every checking task on that code, this one included.
    await reopenPiece(env.DB, row.piece_id, "fault_found", ts);
  } else {
    await env.DB.prepare("UPDATE checking SET status = 'closed', resolution = 'dismissed', decided_at = ? WHERE id = ? AND status = 'flagged'").bind(ts, id).run();
  }
  await audit(env.DB, "admin", `checking_${action}`, id, row.piece_id, ts);
  return json({ ok: true });
}

/** Admin routes for checking work. Returns null when the path is not one of them. */
export async function handleCheckingAdmin(request: Request, env: AppEnv, url: URL, ts: number): Promise<Response | null> {
  if (request.method !== "POST") return null;
  const match = new RegExp(`^/api/admin/checking/(${CHECKING_ID})$`).exec(url.pathname);
  if (!match) return null;
  const body = await readJson(request, LIMITS.checkingRequestMaxBytes);
  if (body.action === "record") return record(env, match[1]!, body, ts);
  if (body.action === "close") return closeWaiting(env, match[1]!, ts);
  if (body.action === "dismiss" || body.action === "reopen_piece") return settle(env, match[1]!, body.action, ts);
  throw new HttpError(400, "invalid_action", '"action" must be record, close, dismiss or reopen_piece.');
}
