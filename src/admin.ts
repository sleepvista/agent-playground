import { AGENT_ID, BUILD_ID, LIMITS, type AppEnv, type Settings } from "./config";
import { ipHash, safeEqual, signPreview } from "./crypto";
import { handleVoteAdmin, voteOverview } from "./vote";
import { problemsOverview } from "./problems";
import { handleWorkAdmin, workOverview } from "./work-admin";
import { HttpError, clientIp, json, readJson } from "./http";
import {
  audit,
  getSettings,
  hit,
  iso,
  listAgents,
  listBuildsByStatus,
  moderateBuild,
  peek,
  saveSettings,
  setAgentBanned,
  siteCounts,
  type AdminBuild,
  type BuildAction,
} from "./store";

async function requireAdmin(request: Request, env: AppEnv, ts: number): Promise<void> {
  const token = env.ADMIN_TOKEN ?? "";
  if (token.length < 32) {
    // Fail closed: no admin access at all until a proper secret is configured.
    throw new HttpError(503, "not_configured", "Admin access is not configured.");
  }
  const failBucket = `adminfail:${await ipHash(env, clientIp(request))}`;
  if ((await peek(env.DB, failBucket, 3600, ts)) >= LIMITS.adminFailuresPerIpPerHour) {
    throw new HttpError(429, "too_many_failed_logins", "Too many failed attempts. Try again in an hour.");
  }
  const header = request.headers.get("Authorization") ?? "";
  const supplied = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (supplied === "" || !(await safeEqual(supplied, token))) {
    await hit(env.DB, failBucket, 3600, ts);
    throw new HttpError(401, "unauthorized", "Wrong admin token.");
  }
}

async function adminBuild(env: AppEnv, build: AdminBuild, ts: number) {
  const base = `${env.SANDBOX_ORIGIN}/b/${build.id}`;
  return {
    id: build.id,
    title: build.title,
    note: build.note,
    model: build.model,
    agent_id: build.agent_id,
    agent_name: build.agent_name,
    status: build.status,
    created_at: iso(build.created_at),
    size_bytes: build.code_bytes,
    report_count: build.report_count,
    report_reasons: build.report_reasons ? build.report_reasons.split(",") : [],
    frame_url:
      build.status === "published" ? base : `${base}?p=${await signPreview(env, build.id, ts + LIMITS.previewSeconds)}`,
  };
}

async function overview(env: AppEnv, ts: number): Promise<Response> {
  const [settings, counts, pending, hidden, published, agents] = await Promise.all([
    getSettings(env.DB),
    siteCounts(env.DB, ts),
    listBuildsByStatus(env.DB, "pending", 50),
    listBuildsByStatus(env.DB, "hidden", 50),
    listBuildsByStatus(env.DB, "published", 30),
    listAgents(env.DB, 50),
  ]);
  const shape = (builds: AdminBuild[]) => Promise.all(builds.map((build) => adminBuild(env, build, ts)));
  return json({
    settings,
    counts,
    pending: await shape(pending),
    hidden: await shape(hidden),
    published: await shape(published),
    agents: agents.map((agent) => ({ ...agent, created_at: iso(agent.created_at) })),
    work: await workOverview(env, ts),
    problems: await problemsOverview(env),
    vote: await voteOverview(env),
  });
}

function intInRange(value: unknown, key: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, "invalid_setting", `"${key}" must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

function parseSettingsPatch(body: Record<string, unknown>): Partial<Settings> {
  const patch: Partial<Settings> = {};
  for (const [key, value] of Object.entries(body)) {
    switch (key) {
      case "registrations_open":
      case "submissions_open":
      case "work_open":
      case "vote_open":
      case "problems_open":
        if (typeof value !== "boolean") throw new HttpError(400, "invalid_setting", `"${key}" must be true or false.`);
        patch[key] = value;
        break;
      case "moderation_mode":
        if (value !== "review" && value !== "trusted") {
          throw new HttpError(400, "invalid_setting", '"moderation_mode" must be "review" or "trusted".');
        }
        patch.moderation_mode = value;
        break;
      case "trust_threshold":
        patch.trust_threshold = intInRange(value, key, 1, 100);
        break;
      case "daily_build_cap":
      case "daily_registration_cap":
        patch[key] = intInRange(value, key, 0, 10_000);
        break;
      default:
        throw new HttpError(400, "invalid_setting", `Unknown setting "${key}".`);
    }
  }
  return patch;
}

export async function handleAdminApi(request: Request, env: AppEnv, url: URL, ts: number): Promise<Response> {
  await requireAdmin(request, env, ts);
  const { pathname } = url;
  const method = request.method;

  if (pathname === "/api/admin/overview" && method === "GET") return overview(env, ts);

  if (pathname === "/api/admin/settings" && method === "POST") {
    const patch = parseSettingsPatch(await readJson(request, LIMITS.smallRequestMaxBytes));
    await saveSettings(env.DB, patch);
    await audit(env.DB, "admin", "settings", "site", JSON.stringify(patch), ts);
    return json({ settings: await getSettings(env.DB) });
  }

  const build = new RegExp(`^/api/admin/builds/(${BUILD_ID})$`).exec(pathname);
  if (build && method === "POST") {
    const { action } = await readJson(request, LIMITS.smallRequestMaxBytes);
    if (action !== "approve" && action !== "reject" && action !== "hide") {
      throw new HttpError(400, "invalid_action", '"action" must be approve, reject or hide.');
    }
    if (!(await moderateBuild(env.DB, build[1]!, action as BuildAction, ts))) {
      throw new HttpError(409, "wrong_state", "That build is not in a state this action applies to.");
    }
    return json({ ok: true });
  }

  const agent = new RegExp(`^/api/admin/agents/(${AGENT_ID})$`).exec(pathname);
  if (agent && method === "POST") {
    const { action } = await readJson(request, LIMITS.smallRequestMaxBytes);
    if (action !== "ban" && action !== "unban") {
      throw new HttpError(400, "invalid_action", '"action" must be ban or unban.');
    }
    if (!(await setAgentBanned(env.DB, agent[1]!, action === "ban", ts))) {
      throw new HttpError(409, "wrong_state", "That agent is not in a state this action applies to.");
    }
    return json({ ok: true });
  }

  const work = await handleWorkAdmin(request, env, url, ts);
  if (work) return work;
  const vote = await handleVoteAdmin(request, env, url, ts);
  if (vote) return vote;

  throw new HttpError(404, "not_found", "No such admin endpoint.");
}
