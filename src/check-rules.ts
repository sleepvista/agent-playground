import type { TestCase } from "./work";

/**
 * What a proposed check must look like, learned from a piece's own checks.
 *
 * A checking agent may only send inputs of the same shape as the ones the
 * site's operator wrote for that function: the same number of arguments, the
 * same kinds of value in the same places, the same field names, numbers of a
 * similar size, and no text other than the names the operator's checks use.
 *
 * This does two jobs. It removes free text altogether: a check cannot carry a
 * sentence, even one built from short words, to the person who reviews
 * findings or to the code it is run against. And it keeps inputs close to
 * what the task was written for, so that a "fault" cannot be manufactured by
 * feeding a correct piece something the task never covered, such as text
 * where a number belongs.
 */

type Kind = "number" | "boolean" | "null" | "string" | "list" | "object";

interface Shape {
  kinds: Set<Kind>;
  /** Fields seen on objects in this place. */
  fields: Map<string, Shape>;
  /** The shape of the entries of lists in this place. */
  entries: Shape | null;
  longest: number;
}

export interface CallRules {
  /** How close two numbers must be to count as equal. */
  tol: number;
  fewestArgs: number;
  mostArgs: number;
  args: Shape[];
  expect: Shape;
  /** The largest number, ignoring sign, that the operator's checks use for this function. */
  largest: number;
}

export interface PieceRules {
  calls: Map<string, CallRules>;
  /** Every piece of text the operator's checks for this piece contain. */
  names: Set<string>;
  /** The inputs of the examples agents are shown, written out, so a check that repeats one can be refused. */
  examples: Set<string>;
}

/** Thrown when a proposed check does not look like the operator's own. The message says how. */
export class CheckRuleError extends Error {}

const kindOf = (value: unknown): Kind =>
  value === null ? "null" : Array.isArray(value) ? "list" : typeof value === "object" ? "object" : (typeof value as Kind);

const blank = (): Shape => ({ kinds: new Set(), fields: new Map(), entries: null, longest: 0 });

function learn(shape: Shape, value: unknown, rules: { names: Set<string>; largest: number }): void {
  const kind = kindOf(value);
  shape.kinds.add(kind);
  if (kind === "number") rules.largest = Math.max(rules.largest, Math.abs(value as number));
  if (kind === "string") rules.names.add(value as string);
  if (kind === "list") {
    const list = value as unknown[];
    shape.longest = Math.max(shape.longest, list.length);
    shape.entries ??= blank();
    for (const entry of list) learn(shape.entries, entry, rules);
  }
  if (kind === "object") {
    for (const [field, entry] of Object.entries(value as Record<string, unknown>)) {
      if (!shape.fields.has(field)) shape.fields.set(field, blank());
      learn(shape.fields.get(field)!, entry, rules);
    }
  }
}

/** Works out the rules for a piece from its own checks, shown and hidden alike. */
export function rulesFor(shown: TestCase[], hidden: TestCase[]): PieceRules {
  const names = new Set<string>();
  const calls = new Map<string, CallRules>();
  const judged = new Set<string>();
  for (const test of [...shown, ...hidden]) {
    if (test.judge !== undefined) judged.add(test.call);
    const rules = calls.get(test.call) ?? { tol: 1e-9, fewestArgs: Infinity, mostArgs: 0, args: [], expect: blank(), largest: 0 };
    calls.set(test.call, rules);
    rules.tol = Math.max(rules.tol, test.tol ?? 1e-9);
    rules.fewestArgs = Math.min(rules.fewestArgs, test.args.length);
    rules.mostArgs = Math.max(rules.mostArgs, test.args.length);
    const seen = { names, largest: rules.largest };
    test.args.forEach((arg, index) => learn((rules.args[index] ??= blank()), arg, seen));
    if (test.expect !== undefined) learn(rules.expect, test.expect, seen);
    rules.largest = seen.largest;
  }
  // A function with more than one right answer is judged, not compared, and cannot be checked this way.
  for (const call of judged) calls.delete(call);
  return { calls, names, examples: new Set(shown.map((test) => JSON.stringify([test.call, test.args]))) };
}

const WORDS: Record<Kind, string> = { number: "a number", boolean: "true or false", null: "null", string: "a name", list: "a list", object: "an object" };

function fit(value: unknown, shape: Shape, where: string, rules: PieceRules, largest: number): void {
  const kind = kindOf(value);
  if (!shape.kinds.has(kind)) {
    const allowed = [...shape.kinds].map((entry) => WORDS[entry]).join(" or ") || "nothing";
    throw new CheckRuleError(`${where} is ${WORDS[kind]}, where the task's own checks have ${allowed}`);
  }
  if (kind === "number" && Math.abs(value as number) > largest) {
    throw new CheckRuleError(`${where} is far larger than any number the task's own checks use (the limit here is ${largest})`);
  }
  if (kind === "string" && !rules.names.has(value as string)) {
    throw new CheckRuleError(`${where} is text the task never uses. The only text a check may hold is a name that appears in the task's examples`);
  }
  if (kind === "list") {
    const list = value as unknown[];
    const most = Math.max(8, shape.longest * 4);
    if (list.length > most) throw new CheckRuleError(`${where} has ${list.length} entries; at most ${most} are allowed here`);
    list.forEach((entry, index) => fit(entry, shape.entries ?? blank(), `${where}[${index}]`, rules, largest));
  }
  if (kind === "object") {
    for (const [field, entry] of Object.entries(value as Record<string, unknown>)) {
      const inner = shape.fields.get(field);
      if (!inner) throw new CheckRuleError(`${where} has a field the task's own checks never use`);
      fit(entry, inner, `${where}.${field}`, rules, largest);
    }
  }
}

/** Throws CheckRuleError unless the check looks like the operator's own checks for that function. */
export function assertCheckFits(check: { call: string; args: unknown[]; expect: unknown }, rules: PieceRules): void {
  const call = rules.calls.get(check.call);
  if (!call) throw new CheckRuleError(`"call" must be one of: ${[...rules.calls.keys()].sort().join(", ")}`);
  if (check.args.length < call.fewestArgs || check.args.length > call.mostArgs) {
    const count = call.fewestArgs === call.mostArgs ? `${call.mostArgs}` : `${call.fewestArgs} to ${call.mostArgs}`;
    throw new CheckRuleError(`${check.call} takes ${count} argument(s); this check gives ${check.args.length}`);
  }
  // Numbers may go well beyond the operator's own, to reach the edges, but not without limit.
  const largest = Math.max(1000, call.largest * 1000);
  check.args.forEach((arg, index) => fit(arg, call.args[index]!, `argument ${index + 1}`, rules, largest));
  // "No answer" is always something a checker may expect.
  if (check.expect !== null) fit(check.expect, call.expect, '"expect"', rules, largest);
  if (rules.examples.has(JSON.stringify([check.call, check.args]))) {
    throw new CheckRuleError("it repeats one of the task's examples, which the piece is already known to pass");
  }
}
