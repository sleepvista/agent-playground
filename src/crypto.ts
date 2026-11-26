import type { AppEnv } from "./config";
import { HttpError } from "./http";

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return Array.from(view, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomHex(byteCount: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(byteCount)));
}

export const API_KEY_PATTERN = /^agp_[A-Za-z0-9_-]{43}$/;

/** 256 bits of randomness; shown to the agent once and never stored. */
export function newApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const base64 = btoa(String.fromCharCode(...bytes));
  return "agp_" + base64.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/** Constant-time comparison of two strings of any length. */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(da, db);
}

function signingSecret(env: AppEnv): string {
  const secret = env.SIGNING_SECRET ?? "";
  if (secret.length < 32) {
    // Fail closed: without the secret we cannot rate-limit or sign anything.
    throw new HttpError(503, "not_configured", "The site is not fully configured yet.");
  }
  return secret;
}

/**
 * Groups an address for rate limiting. An IPv6 customer normally controls a
 * whole /64, so limits apply to the /64 and not to a single address.
 */
export function ipRateKey(ip: string): string {
  if (!ip.includes(":") || ip.includes(".")) return ip;
  const [head = "", tail = ""] = ip.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const groups = ip.includes("::")
    ? [...headGroups, ...Array<string>(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill("0"), ...tailGroups]
    : headGroups;
  return (
    groups
      .slice(0, 4)
      .map((g) => g.toLowerCase().replace(/^0+(?=.)/, ""))
      .join(":") + "::/64"
  );
}

/** Addresses are only ever stored as a keyed hash. */
export async function ipHash(env: AppEnv, ip: string): Promise<string> {
  return (await hmacHex(signingSecret(env), "ip:" + ipRateKey(ip))).slice(0, 32);
}

/** Short-lived token that lets the admin preview an unpublished build in the sandbox. */
export async function signPreview(env: AppEnv, buildId: string, expiresAt: number): Promise<string> {
  return `${expiresAt}.${await hmacHex(signingSecret(env), `preview:${buildId}:${expiresAt}`)}`;
}

export async function verifyPreview(env: AppEnv, buildId: string, token: string, nowSeconds: number): Promise<boolean> {
  const match = /^(\d{1,12})\.([0-9a-f]{64})$/.exec(token);
  if (!match) return false;
  const expiresAt = Number(match[1]);
  if (expiresAt < nowSeconds) return false;
  return safeEqual(token, await signPreview(env, buildId, expiresAt));
}
