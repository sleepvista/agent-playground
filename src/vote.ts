import { LIMITS, type AppEnv } from "./config";
import { ipHash, randomHex } from "./crypto";
import { HttpError, clientIp, json, readJson } from "./http";
import { audit, getSettings, overLimit } from "./store";
import { checkPlainText } from "./text-safety";

/**
 * The shortlist vote: visitors choose which project agents build next.
 *
 * The candidates are written by the site's owner, never by visitors or
 * agents, so nothing a stranger types is shown to anyone. A vote is one row
 * per network, so voting again moves a vote and never adds one. That is a
 * speed bump against stuffing, not proof against it: someone with many
 * networks can still vote many times, and the owner makes the final call.
 */

export const IDEA_ID = "i_[0-9a-f]{16}";

export interface Idea {
  id: string;
  title: string;
  pitch: string;
  votes: number;
}

export async function listIdeas(db: D1Database): Promise<Idea[]> {
  const { results } = await db
    .prepare(
      `SELECT i.id, i.title, i.pitch, (SELECT COUNT(*) FROM idea_votes v WHERE v.idea_id = i.id) AS votes
       FROM ideas i ORDER BY i.position, i.created_at, i.id`,
    )
    .all<Idea>();
  return results;
}

/** Which idea, if any, this visitor's network has voted for. */
export async function votedFor(env: AppEnv, request: Request): Promise<string | null> {
  const row = await env.DB
    .prepare("SELECT idea_id FROM idea_votes WHERE ip_hash = ?")
    .bind(await ipHash(env, clientIp(request)))
    .first<{ idea_id: string }>();
  return row?.idea_id ?? null;
}

async function castVote(request: Request, env: AppEnv, ts: number): Promise<Response> {
  if (!(await getSettings(env.DB)).vote_open) {
    throw new HttpError(503, "vote_closed", "Voting is closed.");
  }
  const { idea } = await readJson(request, LIMITS.smallRequestMaxBytes);
  if (typeof idea !== "string" || !new RegExp(`^${IDEA_ID}$`).test(idea)) {
    throw new HttpError(400, "invalid_idea", '"idea" must be the id of a candidate.');
  }
  const voter = await ipHash(env, clientIp(request));
  if (await overLimit(env.DB, `vote:${voter}`, 86400, LIMITS.voteChangesPerIpPerDay, ts)) {
    throw new HttpError(429, "vote_limit", "This network has changed its vote too many times today.");
  }
  // Only a real candidate can be voted for; the vote row is the network's single vote.
  const result = await env.DB
    .prepare(
      `INSERT INTO idea_votes (ip_hash, idea_id, voted_at)
       SELECT ?, id, ? FROM ideas WHERE id = ?
       ON CONFLICT (ip_hash) DO UPDATE SET idea_id = excluded.idea_id, voted_at = excluded.voted_at`,
    )
    .bind(voter, ts, idea)
    .run();
  if (result.meta.changes !== 1) throw new HttpError(404, "not_found", "No such candidate.");
  return json({ voted_for: idea, ideas: await listIdeas(env.DB) });
}

/** Public routes for the vote. Returns null when the path is not one of them. */
export async function handleVoteApi(request: Request, env: AppEnv, url: URL, ts: number): Promise<Response | null> {
  if (url.pathname === "/api/v1/vote" && request.method === "POST") return castVote(request, env, ts);
  return null;
}

export async function voteOverview(env: AppEnv) {
  const ideas = await listIdeas(env.DB);
  return { ideas, total: ideas.reduce((sum, idea) => sum + idea.votes, 0) };
}

/** Admin routes for the vote. Returns null when the path is not one of them. */
export async function handleVoteAdmin(request: Request, env: AppEnv, url: URL, ts: number): Promise<Response | null> {
  if (request.method !== "POST") return null;
  if (url.pathname === "/api/admin/ideas") {
    const body = await readJson(request, LIMITS.smallRequestMaxBytes);
    const title = checkPlainText(body.title, "title", 3, LIMITS.ideaTitleMax);
    const pitch = checkPlainText(body.pitch, "pitch", 10, LIMITS.ideaPitchMax);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM ideas").first<{ n: number }>();
    if ((count?.n ?? 0) >= LIMITS.ideasMax) {
      throw new HttpError(409, "shortlist_full", `The shortlist holds at most ${LIMITS.ideasMax} candidates.`);
    }
    const id = "i_" + randomHex(8);
    await env.DB
      .prepare("INSERT INTO ideas (id, position, title, pitch, created_at) VALUES (?, (SELECT COALESCE(MAX(position), 0) + 1 FROM ideas), ?, ?, ?)")
      .bind(id, title, pitch, ts)
      .run();
    await audit(env.DB, "admin", "idea_add", id, title, ts);
    return json({ idea: { id, title, pitch, votes: 0 } }, 201);
  }
  if (url.pathname === "/api/admin/votes" ) {
    const { action } = await readJson(request, LIMITS.smallRequestMaxBytes);
    if (action !== "clear") throw new HttpError(400, "invalid_action", '"action" must be clear.');
    await env.DB.prepare("DELETE FROM idea_votes").run();
    await audit(env.DB, "admin", "votes_clear", "vote", "", ts);
    return json({ ok: true });
  }
  const idea = new RegExp(`^/api/admin/ideas/(${IDEA_ID})$`).exec(url.pathname);
  if (idea) {
    const { action } = await readJson(request, LIMITS.smallRequestMaxBytes);
    if (action !== "remove") throw new HttpError(400, "invalid_action", '"action" must be remove.');
    const [, removed] = await env.DB.batch([
      env.DB.prepare("DELETE FROM idea_votes WHERE idea_id = ?").bind(idea[1]!),
      env.DB.prepare("DELETE FROM ideas WHERE id = ?").bind(idea[1]!),
    ]);
    if (removed?.meta.changes !== 1) throw new HttpError(404, "not_found", "No such candidate.");
    await audit(env.DB, "admin", "idea_remove", idea[1]!, "", ts);
    return json({ ok: true });
  }
  return null;
}
