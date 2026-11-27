import { LIMITS } from "./config";

/**
 * "Plain data": what an agent may put in a check it proposes. Numbers, true,
 * false, null, short names, and lists and objects of those. A name is at most
 * 24 letters, digits, "_", "-" or "." with no spaces, so no value and no key
 * can carry a sentence. Checks are shown to a person when they find
 * something, and run against other agents' code; they must never be a way to
 * pass text to either.
 */

const NAME = /^[A-Za-z0-9_.-]{0,24}$/;
const MAX_DEPTH = 8;
const MAX_NODES = 3000;

/** Thrown when a value is not plain data. The message says what was wrong. */
export class PlainDataError extends Error {}

function walk(value: unknown, depth: number, budget: { left: number }): void {
  if (--budget.left < 0) throw new PlainDataError(`holds more than ${MAX_NODES} values`);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PlainDataError("holds a number that is not finite");
    return;
  }
  if (typeof value === "string") {
    if (!NAME.test(value)) {
      throw new PlainDataError('holds text that is not a short name (at most 24 letters, digits, "_", "-" or ".", no spaces)');
    }
    return;
  }
  if (typeof value !== "object") throw new PlainDataError("holds something that is not plain data");
  if (depth >= MAX_DEPTH) throw new PlainDataError(`is nested more than ${MAX_DEPTH} levels deep`);
  if (Array.isArray(value)) {
    for (const item of value) walk(item, depth + 1, budget);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (!NAME.test(key) || key === "") throw new PlainDataError("has a field name that is not a short name");
    if (key === "__proto__" || key === "constructor" || key === "prototype") throw new PlainDataError(`may not use the field name "${key}"`);
    walk(item, depth + 1, budget);
  }
}

/** Throws PlainDataError unless the value is plain data. */
export function assertPlainData(value: unknown): void {
  walk(value, 0, { left: MAX_NODES });
}

/**
 * What a piece of code returned, cut down to something safe to show a person:
 * the same shape, with any text that is not a short name replaced by a
 * marker, and the whole thing kept short. Code written by an agent can return
 * anything, so its answers are never shown as they came.
 */
export function describeForDisplay(value: unknown): string {
  const seen = { left: 400 };
  const clean = (item: unknown, depth: number): unknown => {
    if (--seen.left < 0 || depth > MAX_DEPTH) return "(more)";
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "number") return Number.isFinite(item) ? item : "(not-a-finite-number)";
    if (typeof item === "string") return NAME.test(item) ? item : "(text)";
    if (Array.isArray(item)) return item.map((entry) => clean(entry, depth + 1));
    if (typeof item === "object") {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>).map(([key, entry]) => [NAME.test(key) && key !== "" ? key : "(text)", clean(entry, depth + 1)]),
      );
    }
    return "(something-else)";
  };
  const text = JSON.stringify(clean(value, 0));
  return text.length > LIMITS.findingMaxChars ? text.slice(0, LIMITS.findingMaxChars) + " ..." : text;
}
