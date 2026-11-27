import { LIMITS, PIECE_ID, PROJECT_ID, WORK_ID, type AppEnv } from "./config";
import { signPreview } from "./crypto";
import { HttpError, json, readJson } from "./http";
import { audit, iso } from "./store";
import { listProjects, pieceStatus, type TestCase } from "./work";

/** The shared-projects part of the admin overview. */
export async function workOverview(env: AppEnv, ts: number) {
  const [projects, waiting] = await Promise.all([
    listProjects(env.DB, ts),
    env.DB
      .prepare(
        `SELECT w.id, w.piece_id, p.title AS piece_title, j.title AS project_title, w.agent_id, a.name AS agent_name, w.model,
           w.code_bytes, w.submitted_at, (p.accepted_work_id IS NOT NULL) AS piece_done
         FROM work w JOIN pieces p ON p.id = w.piece_id JOIN projects j ON j.id = w.project_id JOIN agents a ON a.id = w.agent_id
         WHERE w.status = 'submitted' ORDER BY w.submitted_at LIMIT 50`,
      )
      .all<{
        id: string;
        piece_id: string;
        piece_title: string;
        project_title: string;
        agent_id: string;
        agent_name: string;
        model: string;
        code_bytes: number;
        submitted_at: number;
        piece_done: number;
      }>(),
  ]);
  return {
    projects: projects.map((entry) => ({
      id: entry.project.id,
      title: entry.project.title,
      complete: entry.complete,
      pieces: entry.pieces.map((piece) => ({
        id: piece.id,
        title: piece.title,
        status: pieceStatus(piece),
        in_progress: piece.in_progress,
        built_by: piece.built_by,
        built_with: piece.built_with,
      })),
    })),
    waiting: await Promise.all(
      waiting.results.map(async (work) => ({
        id: work.id,
        piece_id: work.piece_id,
        piece_title: work.piece_title,
        project_title: work.project_title,
        piece_done: work.piece_done === 1,
        agent_id: work.agent_id,
        agent_name: work.agent_name,
        model: work.model,
        size_bytes: work.code_bytes,
        submitted_at: iso(work.submitted_at),
        // Opens the submission in the sandbox, where the checks run.
        frame_url: `${env.SANDBOX_ORIGIN}/t/${work.id}?p=${await signPreview(env, work.id, ts + LIMITS.previewSeconds)}`,
      })),
    ),
  };
}

function count(value: unknown, key: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100_000) {
    throw new HttpError(400, "invalid_result", `"${key}" must be a whole number.`);
  }
  return value;
}

async function decide(env: AppEnv, workId: string, body: Record<string, unknown>, ts: number): Promise<Response> {
  const { action } = body;
  if (action !== "accept" && action !== "reject") {
    throw new HttpError(400, "invalid_action", '"action" must be accept or reject.');
  }
  const passed = count(body.tests_passed, "tests_passed");
  const total = count(body.tests_total, "tests_total");
  const work = await env.DB.prepare("SELECT piece_id, status FROM work WHERE id = ?").bind(workId).first<{ piece_id: string; status: string }>();
  if (!work || work.status !== "submitted") {
    throw new HttpError(409, "wrong_state", "That submission is not waiting for a decision.");
  }

  if (action === "accept") {
    // A piece only ever enters a project with every check passing.
    if (total === 0 || passed !== total) {
      throw new HttpError(409, "checks_failed", "A piece can only be accepted when it passes every check.");
    }
    // One transaction: the piece takes this code only if it has none and the work is still waiting,
    // and the work is marked accepted only if the piece took it.
    const [taken] = await env.DB.batch([
      env.DB
        .prepare(
          `UPDATE pieces SET accepted_work_id = ?1, updated_at = ?2
           WHERE id = ?3 AND accepted_work_id IS NULL AND (SELECT status FROM work WHERE id = ?1) = 'submitted'`,
        )
        .bind(workId, ts, work.piece_id),
      env.DB
        .prepare(
          `UPDATE work SET status = 'accepted', tests_passed = ?2, tests_total = ?3, decided_at = ?4
           WHERE id = ?1 AND status = 'submitted' AND EXISTS (SELECT 1 FROM pieces WHERE accepted_work_id = ?1)`,
        )
        .bind(workId, passed, total, ts),
    ]);
    if (taken?.meta.changes !== 1) throw new HttpError(409, "piece_done", "That piece has already been built, or this work was already decided.");
  } else {
    // Rejected code can never be used, so it is not kept.
    const [rejected] = await env.DB.batch([
      env.DB
        .prepare("UPDATE work SET status = 'rejected', tests_passed = ?, tests_total = ?, decided_at = ? WHERE id = ? AND status = 'submitted'")
        .bind(passed, total, ts, workId),
      env.DB.prepare("DELETE FROM work_code WHERE work_id = ? AND EXISTS (SELECT 1 FROM work WHERE id = ? AND status = 'rejected')").bind(workId, workId),
    ]);
    if (rejected?.meta.changes !== 1) throw new HttpError(409, "wrong_state", "That submission is not waiting for a decision.");
  }
  await audit(env.DB, "admin", `work_${action}`, workId, `${passed}/${total}`, ts);
  return json({ ok: true });
}

/**
 * Throws out a piece's accepted code so another agent can build it. Any
 * checking of that code stops with it. Returns false if the piece is not built.
 */
export async function reopenPiece(db: D1Database, pieceId: string, why: string, ts: number): Promise<boolean> {
  const piece = await db.prepare("SELECT accepted_work_id FROM pieces WHERE id = ?").bind(pieceId).first<{ accepted_work_id: string | null }>();
  if (!piece?.accepted_work_id) return false;
  await db.batch([
    db.prepare("UPDATE work SET status = 'rejected', decided_at = ? WHERE id = ?").bind(ts, piece.accepted_work_id),
    db.prepare("UPDATE pieces SET accepted_work_id = NULL, updated_at = ? WHERE id = ?").bind(ts, pieceId),
    db
      .prepare(
        `UPDATE checking SET status = 'closed', resolution = 'piece_reopened', decided_at = ?
         WHERE work_id = ? AND status IN ('claimed', 'submitted', 'flagged')`,
      )
      .bind(ts, piece.accepted_work_id),
  ]);
  await audit(db, "admin", "piece_reopen", pieceId, `${piece.accepted_work_id} ${why}`, ts);
  return true;
}

async function reopen(env: AppEnv, pieceId: string, ts: number): Promise<Response> {
  if (!(await reopenPiece(env.DB, pieceId, "by_hand", ts))) throw new HttpError(409, "wrong_state", "That piece is not built.");
  return json({ ok: true });
}

/**
 * Which of a piece's functions can be given extra checks later, each with how
 * close two numbers must be to count as equal. A function whose answers are
 * judged rather than compared has more than one right answer, so it is left out.
 */
function checkCalls(tests: TestCase[]): Record<string, number> {
  const calls = new Map<string, { tol: number; judged: boolean }>();
  for (const test of tests) {
    const entry = calls.get(test.call) ?? { tol: 1e-9, judged: false };
    calls.set(test.call, { tol: Math.max(entry.tol, test.tol ?? 1e-9), judged: entry.judged || test.judge !== undefined });
  }
  return Object.fromEntries([...calls].filter(([, entry]) => !entry.judged).map(([name, entry]) => [name, entry.tol]));
}

function text(value: unknown, key: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new HttpError(400, "invalid_content", `"${key}" must be text of at most ${max} characters.`);
  }
  return value;
}

function tests(value: unknown, key: string): TestCase[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpError(400, "invalid_content", `"${key}" must be a non-empty list of checks.`);
  }
  for (const test of value as Record<string, unknown>[]) {
    const judged = typeof test.judge === "object" && test.judge !== null;
    if (typeof test.name !== "string" || typeof test.call !== "string" || !Array.isArray(test.args) || (!judged && !("expect" in test))) {
      throw new HttpError(400, "invalid_content", `Every check in "${key}" needs a name, a call, args and an expected result.`);
    }
  }
  return value as TestCase[];
}

function id(value: unknown, pattern: string, what: string): string {
  if (typeof value !== "string" || !new RegExp(`^${pattern}$`).test(value)) {
    throw new HttpError(400, "invalid_content", `"${String(value)}" is not a valid ${what} id.`);
  }
  return value;
}

/**
 * Loads or replaces one project: what it is, its pieces, and the program that
 * runs on them once they are all built. Content is written privately and
 * loaded here; it is not part of the public code. Loading a project again
 * keeps who built what.
 */
async function loadContent(env: AppEnv, body: Record<string, unknown>, ts: number): Promise<Response> {
  if (typeof body.project !== "object" || body.project === null) {
    throw new HttpError(400, "invalid_content", '"project" must say which project this is: { id, title, summary }.');
  }
  const project = body.project as Record<string, unknown>;
  const projectId = id(project.id, PROJECT_ID, "project");
  const pieces = Array.isArray(body.pieces) ? (body.pieces as Record<string, unknown>[]) : [];
  if (pieces.length === 0) throw new HttpError(400, "invalid_content", "A project needs at least one piece.");
  const showcase = typeof body.showcase === "object" && body.showcase !== null ? (body.showcase as Record<string, unknown>) : null;

  const statements: D1PreparedStatement[] = [
    // A new project goes to the end of the list. A showcase that is left out keeps the one already stored.
    env.DB
      .prepare(
        `INSERT INTO projects (id, position, title, summary, showcase_title, showcase_note, showcase_code, updated_at)
         VALUES (?1, (SELECT COALESCE(MAX(position), -1) + 1 FROM projects), ?2, ?3, COALESCE(?4, ''), COALESCE(?5, ''), COALESCE(?6, ''), ?7)
         ON CONFLICT (id) DO UPDATE SET title = excluded.title, summary = excluded.summary,
           showcase_title = COALESCE(?4, projects.showcase_title), showcase_note = COALESCE(?5, projects.showcase_note),
           showcase_code = COALESCE(?6, projects.showcase_code), updated_at = excluded.updated_at`,
      )
      .bind(
        projectId,
        text(project.title, "title", LIMITS.projectTitleMax),
        text(project.summary, "summary", LIMITS.projectSummaryMax),
        showcase ? text(showcase.title, "title", 80) : null,
        showcase ? text(showcase.note, "note", 500) : null,
        showcase ? text(showcase.code, "code", 200_000) : null,
        ts,
      ),
  ];
  const pieceIds: string[] = [];
  pieces.forEach((piece, position) => {
    const pieceId = id(piece.id, PIECE_ID, "piece");
    pieceIds.push(pieceId);
    const shown = tests(piece.public_tests, "public_tests");
    const hidden = tests(piece.hidden_tests, "hidden_tests");
    statements.push(
      env.DB
        .prepare(
          `INSERT INTO pieces (id, project_id, position, title, summary, spec, public_tests, hidden_tests, check_calls, reference_code, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET position = excluded.position, title = excluded.title, summary = excluded.summary,
             spec = excluded.spec, public_tests = excluded.public_tests, hidden_tests = excluded.hidden_tests,
             check_calls = excluded.check_calls, reference_code = excluded.reference_code, updated_at = excluded.updated_at`,
        )
        .bind(
          pieceId,
          projectId,
          position,
          text(piece.title, "title", 80),
          text(piece.summary, "summary", 200),
          text(piece.spec, "spec", 20_000),
          JSON.stringify(shown),
          JSON.stringify(hidden),
          JSON.stringify(checkCalls([...shown, ...hidden])),
          typeof piece.reference_code === "string" ? piece.reference_code : "",
          ts,
        ),
    );
  });
  if (new Set(pieceIds).size !== pieceIds.length) throw new HttpError(400, "invalid_content", "Two pieces have the same id.");
  // Piece ids are unique across the whole site, so a piece can never move between projects by accident.
  const taken = await env.DB
    .prepare(`SELECT id FROM pieces WHERE project_id <> ?1 AND id IN (${pieceIds.map((_, index) => `?${index + 2}`).join(", ")})`)
    .bind(projectId, ...pieceIds)
    .first<{ id: string }>();
  if (taken) throw new HttpError(409, "piece_id_taken", `Another project already has a piece with the id "${taken.id}".`);

  await env.DB.batch(statements);
  await audit(env.DB, "admin", "content_load", projectId, `${pieces.length} pieces`, ts);
  return json({ loaded: { project: projectId, pieces: pieces.length, showcase: showcase !== null } });
}

/** Admin routes for the shared projects. Returns null when the path is not one of them. */
export async function handleWorkAdmin(request: Request, env: AppEnv, url: URL, ts: number): Promise<Response | null> {
  if (request.method !== "POST") return null;
  const { pathname } = url;
  if (pathname === "/api/admin/content") {
    return loadContent(env, await readJson(request, LIMITS.contentRequestMaxBytes), ts);
  }
  const work = new RegExp(`^/api/admin/work/(${WORK_ID})$`).exec(pathname);
  if (work) return decide(env, work[1]!, await readJson(request, LIMITS.smallRequestMaxBytes), ts);
  const piece = new RegExp(`^/api/admin/pieces/(${PIECE_ID})$`).exec(pathname);
  if (piece) {
    const { action } = await readJson(request, LIMITS.smallRequestMaxBytes);
    if (action !== "reopen") throw new HttpError(400, "invalid_action", '"action" must be reopen.');
    return reopen(env, piece[1]!, ts);
  }
  return null;
}
