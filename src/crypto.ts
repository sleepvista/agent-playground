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

/**
 * Whether a secret is fit to protect a real site: long enough, and not one of
 * the example values that sit in this public repository for local use.
 */
export function usableSecret(env: AppEnv, secret: string | undefined): secret is string {
  if (secret === undefined || secret.length < 32) return false;
  return !(env.GALLERY_ORIGIN.startsWith("https://") && secret.includes("change-me"));
}

function signingSecret(env: AppEnv): string {
  const secret = env.SIGNING_SECRET ?? "";
  if (!usableSecret(env, secret)) {
    // Fail closed: without the secret we cannot rate-limit or sign anything.
    throw new HttpError(503, "not_configured", "The site is not fully configured yet.");
  }
  return secret;
}

/**
 * Groups an address for rate limiting and for "one per network" rules.
 *
 * An IPv4 address stands for itself. An IPv6 customer is normally handed far
 * more than one address: a home line usually gets a /56 (256 separate /64s),
 * and a hosting account often a /48. Grouping by /64 would let one customer
 * pass as hundreds of networks, so IPv6 is grouped by /56 by default.
 */
export function ipRateKey(ip: string, prefixBits = 56): string {
  if (!ip.includes(":") || ip.includes(".")) return ip;
  const [head = "", tail = ""] = ip.split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const groups = ip.includes("::")
    ? [...headGroups, ...Array<string>(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill("0"), ...tailGroups]
    : headGroups;
  const hex = groups.map((group) => group.toLowerCase().padStart(4, "0")).join("");
  return `${hex.slice(0, prefixBits / 4)}/${prefixBits}`;
}

/** Addresses are only ever stored as a keyed hash. */
export async function ipHash(env: AppEnv, ip: string): Promise<string> {
  return (await hmacHex(signingSecret(env), "ip:" + ipRateKey(ip))).slice(0, 32);
}

/**
 * A wider grouping for IPv6, used beside the usual one with a looser limit so
 * that a whole hosting allocation cannot register agents without end. Null
 * for IPv4, where an address is already as wide as one customer gets.
 */
export async function ipWideHash(env: AppEnv, ip: string): Promise<string | null> {
  const wide = ipRateKey(ip, 48);
  return wide === ip ? null : (await hmacHex(signingSecret(env), "ipwide:" + wide)).slice(0, 32);
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
