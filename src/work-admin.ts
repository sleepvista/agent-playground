import { LIMITS, PIECE_ID, WORK_ID, type AppEnv } from "./config";
import { signPreview } from "./crypto";
import { HttpError, json, readJson } from "./http";
import { audit, iso } from "./store";
import { listPieces, pieceStatus, type TestCase } from "./work";

/** The engine-project part of the admin overview. */
export async function workOverview(env: AppEnv, ts: number) {
  const [pieces, waiting] = await Promise.all([
    listPieces(env.DB, ts),
    env.DB
      .prepare(
        `SELECT w.id, w.piece_id, p.title AS piece_title, w.agent_id, a.name AS agent_name, w.model, w.code_bytes,
           w.submitted_at, (p.accepted_work_id IS NOT NULL) AS piece_done
         FROM work w JOIN pieces p ON p.id = w.piece_id JOIN agents a ON a.id = w.agent_id
         WHERE w.status = 'submitted' ORDER BY w.submitted_at LIMIT 50`,
      )
      .all<{
        id: string;
        piece_id: string;
        piece_title: string;
        agent_id: string;
        agent_name: string;
        model: string;
        code_bytes: number;
        submitted_at: number;
        piece_done: number;
      }>(),
  ]);
  return {
    pieces: pieces.map((piece) => ({
      id: piece.id,
      title: piece.title,
      status: pieceStatus(piece),
      in_progress: piece.in_progress,
      built_by: piece.built_by,
      built_with: piece.built_with,
    })),
    work: await Promise.all(
      waiting.results.map(async (work) => ({
        id: work.id,
        piece_id: work.piece_id,
        piece_title: work.piece_title,
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
    // A piece only ever enters the engine with every check passing.
    if (total === 0 || passed !== total) {
      throw new HttpError(409, "checks_failed", "A piece can only be accepted when it passes every check.");
    }
    const taken = await env.DB
      .prepare("UPDATE pieces SET accepted_work_id = ?, updated_at = ? WHERE id = ? AND accepted_work_id IS NULL")
      .bind(workId, ts, work.piece_id)
      .run();
    if (taken.meta.changes !== 1) throw new HttpError(409, "piece_done", "That piece has already been built.");
  }
  await env.DB
    .prepare("UPDATE work SET status = ?, tests_passed = ?, tests_total = ?, decided_at = ? WHERE id = ? AND status = 'submitted'")
    .bind(action === "accept" ? "accepted" : "rejected", passed, total, ts, workId)
    .run();
  await audit(env.DB, "admin", `work_${action}`, workId, `${passed}/${total}`, ts);
  return json({ ok: true });
}

async function reopen(env: AppEnv, pieceId: string, ts: number): Promise<Response> {
  const piece = await env.DB.prepare("SELECT accepted_work_id FROM pieces WHERE id = ?").bind(pieceId).first<{ accepted_work_id: string | null }>();
  if (!piece?.accepted_work_id) throw new HttpError(409, "wrong_state", "That piece is not built.");
  await env.DB.batch([
    env.DB.prepare("UPDATE work SET status = 'rejected', decided_at = ? WHERE id = ?").bind(ts, piece.accepted_work_id),
    env.DB.prepare("UPDATE pieces SET accepted_work_id = NULL, updated_at = ? WHERE id = ?").bind(ts, pieceId),
  ]);
  await audit(env.DB, "admin", "piece_reopen", pieceId, piece.accepted_work_id, ts);
  return json({ ok: true });
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

/**
 * Loads or replaces the project's content: the pieces and the program that
 * runs on the finished engine. Content is written privately and loaded here;
 * it is not part of the public code. Replacing a piece keeps who built it.
 */
async function loadContent(env: AppEnv, body: Record<string, unknown>, ts: number): Promise<Response> {
  const statements: D1PreparedStatement[] = [];
  const pieces = Array.isArray(body.pieces) ? (body.pieces as Record<string, unknown>[]) : [];
  pieces.forEach((piece, position) => {
    const id = text(piece.id, "id", 31);
    if (!new RegExp(`^${PIECE_ID}$`).test(id)) throw new HttpError(400, "invalid_content", `"${id}" is not a valid piece id.`);
    statements.push(
      env.DB
        .prepare(
          `INSERT INTO pieces (id, position, title, summary, spec, public_tests, hidden_tests, reference_code, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET position = excluded.position, title = excluded.title, summary = excluded.summary,
             spec = excluded.spec, public_tests = excluded.public_tests, hidden_tests = excluded.hidden_tests,
             reference_code = excluded.reference_code, updated_at = excluded.updated_at`,
        )
        .bind(
          id,
          position,
          text(piece.title, "title", 80),
          text(piece.summary, "summary", 200),
          text(piece.spec, "spec", 20_000),
          JSON.stringify(tests(piece.public_tests, "public_tests")),
          JSON.stringify(tests(piece.hidden_tests, "hidden_tests")),
          typeof piece.reference_code === "string" ? piece.reference_code : "",
          ts,
        ),
    );
  });
  if (typeof body.showcase === "object" && body.showcase !== null) {
    const showcase = body.showcase as Record<string, unknown>;
    statements.push(
      env.DB
        .prepare(
          `INSERT INTO showcase (id, title, note, code, updated_at) VALUES (1, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET title = excluded.title, note = excluded.note, code = excluded.code, updated_at = excluded.updated_at`,
        )
        .bind(text(showcase.title, "title", 80), text(showcase.note, "note", 500), text(showcase.code, "code", 200_000), ts),
    );
  }
  if (statements.length === 0) throw new HttpError(400, "invalid_content", "Nothing to load.");
  await env.DB.batch(statements);
  await audit(env.DB, "admin", "content_load", "engine", `${pieces.length} pieces`, ts);
  return json({ loaded: { pieces: pieces.length, showcase: "showcase" in body } });
}

/** Admin routes for the engine project. Returns null when the path is not one of them. */
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
