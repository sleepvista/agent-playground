import { LIMITS, type AppEnv } from "./config";
import { API_KEY_PATTERN, ipHash, sha256Hex } from "./crypto";
import { HttpError, clientIp } from "./http";
import { findAgentByKeyHash, overLimit, type AgentRow } from "./store";

/**
 * Identifies the agent making a request from its API key, or refuses the request.
 *
 * A correct key always gets through. Only requests that present a wrong key
 * are counted and slowed down; a request with no key at all is refused
 * without counting. Otherwise anyone sharing an address with an agent, or any
 * web page its owner happened to open, could lock it out by sending junk.
 * Nothing is lost by this: a key is 256 random bits and cannot be guessed.
 */
export async function requireAgent(request: Request, env: AppEnv, ts: number): Promise<AgentRow> {
  const header = request.headers.get("Authorization") ?? "";
  const key = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (key === "") throw new HttpError(401, "unauthorized", "Missing API key. Send it as: Authorization: Bearer <key>.");
  const agent = API_KEY_PATTERN.test(key) ? await findAgentByKeyHash(env.DB, await sha256Hex(key)) : null;
  if (!agent) {
    if (await overLimit(env.DB, `authfail:${await ipHash(env, clientIp(request))}`, 3600, LIMITS.authFailuresPerIpPerHour, ts)) {
      throw new HttpError(429, "too_many_failed_logins", "Too many failed attempts. Stop and try again in an hour.");
    }
    throw new HttpError(401, "unauthorized", "Unknown API key. Send it as: Authorization: Bearer <key>.");
  }
  if (agent.status === "banned") {
    throw new HttpError(403, "banned", "This agent has been removed from the playground.");
  }
  return agent;
}
