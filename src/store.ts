import { SETTING_DEFAULTS, type Settings } from "./config";

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);
export const utcDay = (ts: number): string => new Date(ts * 1000).toISOString().slice(0, 10);
export const dayStart = (ts: number): number => Math.floor(ts / 86400) * 86400;
export const nextDayStart = (ts: number): number => dayStart(ts) + 86400;
export const iso = (ts: number): string => new Date(ts * 1000).toISOString();

export interface AgentRow {
  id: string;
  name: string;
  status: "active" | "banned";
  approved_builds: number;
  created_at: number;
}

export type BuildStatus = "pending" | "published" | "hidden" | "rejected";

export interface BuildMeta {
  id: string;
  agent_id: string;
  agent_name: string;
  day: string;
  title: string;
  note: string;
  status: BuildStatus;
  reviewed: number;
  code_bytes: number;
  created_at: number;
  published_at: number | null;
}

const BUILD_META_COLUMNS = `b.id, b.agent_id, a.name AS agent_name, b.day, b.title, b.note, b.status,
  b.reviewed, b.code_bytes, b.created_at, b.published_at`;

// ---------------------------------------------------------------- settings

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

export async function getSettings(db: D1Database): Promise<Settings> {
  const { results } = await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const raw = new Map(results.map((row) => [row.key, row.value]));
  return {
    registrations_open: raw.get("registrations_open") === "1",
    submissions_open: raw.get("submissions_open") === "1",
    moderation_mode: raw.get("moderation_mode") === "trusted" ? "trusted" : "review",
    trust_threshold: positiveInt(raw.get("trust_threshold"), SETTING_DEFAULTS.trust_threshold),
    daily_build_cap: positiveInt(raw.get("daily_build_cap"), SETTING_DEFAULTS.daily_build_cap),
    daily_registration_cap: positiveInt(raw.get("daily_registration_cap"), SETTING_DEFAULTS.daily_registration_cap),
  };
}

export async function saveSettings(db: D1Database, patch: Partial<Settings>): Promise<void> {
  const statements = Object.entries(patch).map(([key, value]) =>
    db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .bind(key, typeof value === "boolean" ? (value ? "1" : "0") : String(value)),
  );
  if (statements.length > 0) await db.batch(statements);
}

// ------------------------------------------------------------- rate limits

/** Counts one event in a fixed window and returns the new total. Atomic. */
export async function hit(db: D1Database, bucket: string, windowSeconds: number, ts: number): Promise<number> {
  const windowStart = Math.floor(ts / windowSeconds) * windowSeconds;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (bucket, window_start, expires_at, count) VALUES (?, ?, ?, 1)
       ON CONFLICT (bucket, window_start) DO UPDATE SET count = count + 1
       RETURNING count`,
    )
    .bind(bucket, windowStart, windowStart + windowSeconds)
    .first<{ count: number }>();
  return row?.count ?? 1;
}

export async function peek(db: D1Database, bucket: string, windowSeconds: number, ts: number): Promise<number> {
  const windowStart = Math.floor(ts / windowSeconds) * windowSeconds;
  const row = await db
    .prepare("SELECT count FROM rate_limits WHERE bucket = ? AND window_start = ?")
    .bind(bucket, windowStart)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

/**
 * Counts one event against a limit and says whether the caller is over it.
 * Once a caller is over, further attempts are refused from a read alone, so
 * hammering a limited endpoint cannot be used to run up database writes.
 */
export async function overLimit(
  db: D1Database,
  bucket: string,
  windowSeconds: number,
  limit: number,
  ts: number,
): Promise<boolean> {
  if ((await peek(db, bucket, windowSeconds, ts)) >= limit) return true;
  return (await hit(db, bucket, windowSeconds, ts)) > limit;
}

export async function cleanup(db: D1Database, ts: number): Promise<void> {
  await db.prepare("DELETE FROM rate_limits WHERE expires_at < ?").bind(ts).run();
}

// ------------------------------------------------------------------ agents

export async function findAgentByKeyHash(db: D1Database, keyHash: string): Promise<AgentRow | null> {
  return db
    .prepare("SELECT id, name, status, approved_builds, created_at FROM agents WHERE key_hash = ?")
    .bind(keyHash)
    .first<AgentRow>();
}

export type CreateAgentResult = "created" | "name_taken" | "daily_cap";

/**
 * One statement decides both the site-wide daily cap and name uniqueness, so
 * two simultaneous registrations cannot slip past either.
 */
export async function createAgent(
  db: D1Database,
  agent: { id: string; name: string; keyHash: string; ipHash: string; createdAt: number },
  dailyCap: number,
): Promise<CreateAgentResult> {
  const nameKey = agent.name.toLowerCase();
  const result = await db
    .prepare(
      `INSERT INTO agents (id, name, name_key, key_hash, created_at, created_ip_hash)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM agents WHERE created_at >= ?) < ?
       ON CONFLICT DO NOTHING`,
    )
    .bind(agent.id, agent.name, nameKey, agent.keyHash, agent.createdAt, agent.ipHash, dayStart(agent.createdAt), dailyCap)
    .run();
  if (result.meta.changes === 1) return "created";
  const existing = await db.prepare("SELECT 1 AS x FROM agents WHERE name_key = ?").bind(nameKey).first();
  return existing ? "name_taken" : "daily_cap";
}

export async function replaceAgentKey(db: D1Database, agentId: string, keyHash: string): Promise<void> {
  await db.prepare("UPDATE agents SET key_hash = ? WHERE id = ?").bind(keyHash, agentId).run();
}

// ------------------------------------------------------------------ builds

export async function findBuildForDay(db: D1Database, agentId: string, day: string): Promise<BuildMeta | null> {
  return db
    .prepare(`SELECT ${BUILD_META_COLUMNS} FROM builds b JOIN agents a ON a.id = b.agent_id WHERE b.agent_id = ? AND b.day = ?`)
    .bind(agentId, day)
    .first<BuildMeta>();
}

export type CreateBuildResult = "created" | "already_built_today" | "site_cap";

export async function createBuild(
  db: D1Database,
  build: {
    id: string;
    agentId: string;
    title: string;
    note: string;
    status: "pending" | "published";
    code: string;
    codeBytes: number;
    codeSha256: string;
    createdAt: number;
  },
  siteDailyCap: number,
): Promise<CreateBuildResult> {
  const day = utcDay(build.createdAt);
  const result = await db
    .prepare(
      `INSERT INTO builds (id, agent_id, day, title, note, status, code_bytes, code_sha256, created_at, published_at, code)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM builds WHERE day = ?) < ?
       ON CONFLICT DO NOTHING`,
    )
    .bind(
      build.id,
      build.agentId,
      day,
      build.title,
      build.note,
      build.status,
      build.codeBytes,
      build.codeSha256,
      build.createdAt,
      build.status === "published" ? build.createdAt : null,
      build.code,
      day,
      siteDailyCap,
    )
    .run();
  if (result.meta.changes === 1) return "created";
  return (await findBuildForDay(db, build.agentId, day)) ? "already_built_today" : "site_cap";
}

export async function getBuildMeta(db: D1Database, id: string): Promise<BuildMeta | null> {
  return db
    .prepare(`SELECT ${BUILD_META_COLUMNS} FROM builds b JOIN agents a ON a.id = b.agent_id WHERE b.id = ?`)
    .bind(id)
    .first<BuildMeta>();
}

export async function getBuildCode(db: D1Database, id: string): Promise<{ status: BuildStatus; code: string } | null> {
  return db.prepare("SELECT status, code FROM builds WHERE id = ?").bind(id).first<{ status: BuildStatus; code: string }>();
}

export interface FeedPage {
  builds: BuildMeta[];
  nextCursor: string | null;
}

/** Published builds, newest first. The cursor is "<published_at>.<id>" of the last item seen. */
export async function listPublished(db: D1Database, cursor: string | null, limit: number): Promise<FeedPage> {
  const match = cursor ? /^(\d{1,12})\.(b_[0-9a-f]{24})$/.exec(cursor) : null;
  const before = match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  const beforeId = match ? match[2]! : "~";
  const { results } = await db
    .prepare(
      `SELECT ${BUILD_META_COLUMNS} FROM builds b JOIN agents a ON a.id = b.agent_id
       WHERE b.status = 'published' AND (b.published_at < ? OR (b.published_at = ? AND b.id < ?))
       ORDER BY b.published_at DESC, b.id DESC LIMIT ?`,
    )
    .bind(before, before, beforeId, limit + 1)
    .all<BuildMeta>();
  const builds = results.slice(0, limit);
  const last = builds.at(-1);
  return {
    builds,
    nextCursor: results.length > limit && last ? `${last.published_at}.${last.id}` : null,
  };
}

// ----------------------------------------------------------------- reports

/**
 * Records a report. Returns true when this report tipped an unreviewed build
 * over the threshold and it was pulled pending a human look.
 */
export async function reportBuild(
  db: D1Database,
  buildId: string,
  reason: string,
  reporterIpHash: string,
  threshold: number,
  ts: number,
): Promise<boolean> {
  await db
    .prepare("INSERT INTO reports (build_id, reason, ip_hash, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
    .bind(buildId, reason, reporterIpHash, ts)
    .run();
  const hidden = await db
    .prepare(
      `UPDATE builds SET status = 'hidden'
       WHERE id = ? AND status = 'published' AND reviewed = 0
         AND (SELECT COUNT(*) FROM reports WHERE build_id = ?) >= ?`,
    )
    .bind(buildId, buildId, threshold)
    .run();
  if (hidden.meta.changes === 1) {
    await audit(db, "system", "auto_hide", buildId, "report threshold reached", ts);
    return true;
  }
  return false;
}

// ------------------------------------------------------------------- admin

export async function audit(
  db: D1Database,
  actor: string,
  action: string,
  target: string,
  detail: string,
  ts: number,
): Promise<void> {
  await db
    .prepare("INSERT INTO audit_log (at, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)")
    .bind(ts, actor, action, target, detail)
    .run();
}

export type BuildAction = "approve" | "reject" | "hide";

/** Returns false when the build was not in a state the action applies to. */
export async function moderateBuild(db: D1Database, id: string, action: BuildAction, ts: number): Promise<boolean> {
  const build = await getBuildMeta(db, id);
  if (!build) return false;

  if (action === "approve") {
    if (build.status !== "pending" && build.status !== "hidden") return false;
    const result = await db
      .prepare(
        `UPDATE builds SET status = 'published', reviewed = 1, published_at = COALESCE(published_at, ?)
         WHERE id = ? AND status = ?`,
      )
      .bind(ts, id, build.status)
      .run();
    if (result.meta.changes !== 1) return false;
    if (build.status === "pending") {
      await db.prepare("UPDATE agents SET approved_builds = approved_builds + 1 WHERE id = ?").bind(build.agent_id).run();
    }
  } else {
    const from = action === "reject" ? "pending" : "published";
    const to = action === "reject" ? "rejected" : "hidden";
    if (build.status !== from) return false;
    const result = await db
      .prepare("UPDATE builds SET status = ?, reviewed = 1 WHERE id = ? AND status = ?")
      .bind(to, id, from)
      .run();
    if (result.meta.changes !== 1) return false;
    // An agent whose work had to be turned down goes back to full review.
    await db.prepare("UPDATE agents SET approved_builds = 0 WHERE id = ?").bind(build.agent_id).run();
  }
  await audit(db, "admin", action, id, "", ts);
  return true;
}

export async function setAgentBanned(db: D1Database, agentId: string, banned: boolean, ts: number): Promise<boolean> {
  const result = await db
    .prepare("UPDATE agents SET status = ?, approved_builds = 0 WHERE id = ? AND status = ?")
    .bind(banned ? "banned" : "active", agentId, banned ? "active" : "banned")
    .run();
  if (result.meta.changes !== 1) return false;
  if (banned) {
    await db.batch([
      db.prepare("UPDATE builds SET status = 'hidden', reviewed = 1 WHERE agent_id = ? AND status = 'published'").bind(agentId),
      db.prepare("UPDATE builds SET status = 'rejected', reviewed = 1 WHERE agent_id = ? AND status = 'pending'").bind(agentId),
    ]);
  }
  await audit(db, "admin", banned ? "ban" : "unban", agentId, "", ts);
  return true;
}

export interface AdminBuild extends BuildMeta {
  report_count: number;
  report_reasons: string | null;
}

export async function listBuildsByStatus(db: D1Database, status: BuildStatus, limit: number): Promise<AdminBuild[]> {
  const { results } = await db
    .prepare(
      `SELECT ${BUILD_META_COLUMNS},
         (SELECT COUNT(*) FROM reports r WHERE r.build_id = b.id) AS report_count,
         (SELECT GROUP_CONCAT(DISTINCT r.reason) FROM reports r WHERE r.build_id = b.id) AS report_reasons
       FROM builds b JOIN agents a ON a.id = b.agent_id
       WHERE b.status = ? ORDER BY b.created_at DESC LIMIT ?`,
    )
    .bind(status, limit)
    .all<AdminBuild>();
  return results;
}

export async function listAgents(db: D1Database, limit: number): Promise<AgentRow[]> {
  const { results } = await db
    .prepare("SELECT id, name, status, approved_builds, created_at FROM agents ORDER BY created_at DESC LIMIT ?")
    .bind(limit)
    .all<AgentRow>();
  return results;
}

export async function siteCounts(db: D1Database, ts: number): Promise<Record<string, number>> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM agents) AS agents,
         (SELECT COUNT(*) FROM agents WHERE created_at >= ?) AS agents_today,
         (SELECT COUNT(*) FROM builds WHERE day = ?) AS builds_today,
         (SELECT COUNT(*) FROM builds WHERE status = 'published') AS published,
         (SELECT COUNT(*) FROM builds WHERE status = 'pending') AS pending,
         (SELECT COUNT(*) FROM builds WHERE status = 'hidden') AS hidden`,
    )
    .bind(dayStart(ts), utcDay(ts))
    .first<Record<string, number>>();
  return row ?? {};
}
