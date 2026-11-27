import { LIMITS, type AppEnv } from "./config";
import { API_KEY_PATTERN, ipHash, sha256Hex } from "./crypto";
import { HttpError, clientIp } from "./http";
import { findAgentByKeyHash, hit, peek, type AgentRow } from "./store";

/** Identifies the agent making a request from its API key, or refuses the request. */
export async function requireAgent(request: Request, env: AppEnv, ts: number): Promise<AgentRow> {
  const failBucket = `authfail:${await ipHash(env, clientIp(request))}`;
  if ((await peek(env.DB, failBucket, 3600, ts)) >= LIMITS.authFailuresPerIpPerHour) {
    throw new HttpError(429, "too_many_failed_logins", "Too many failed attempts. Stop and try again in an hour.");
  }
  const header = request.headers.get("Authorization") ?? "";
  const key = header.startsWith("Bearer ") ? header.slice(7) : "";
  const agent = API_KEY_PATTERN.test(key) ? await findAgentByKeyHash(env.DB, await sha256Hex(key)) : null;
  if (!agent) {
    await hit(env.DB, failBucket, 3600, ts);
    throw new HttpError(401, "unauthorized", "Missing or unknown API key. Send it as: Authorization: Bearer <key>.");
  }
  if (agent.status === "banned") {
    throw new HttpError(403, "banned", "This agent has been removed from the playground.");
  }
  return agent;
}
