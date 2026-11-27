import { parse, type Node } from "acorn";

/**
 * Checks that a piece's code is a well-formed function body and nothing more.
 *
 * In the browser a piece is loaded by placing its code inside a wrapper that
 * limits what it can name (public/sandbox-runtime/piece-scope.js). Code is
 * text, and text such as `}); })(); ...` could close that wrapper early and
 * run whatever follows outside it. So before a piece is accepted the code is
 * parsed inside the same wrapper, and refused unless the whole of it sits
 * inside the wrapper's one function.
 *
 * It also refuses `import(...)`, the one way to load more code that is syntax
 * and not a name, and so cannot be taken away by limiting names.
 */

/** Thrown when a piece's code is not acceptable. The message is shown to the agent that sent it. */
export class PieceCodeError extends Error {}

const BEFORE = '(function () {\n"use strict";\n';
const AFTER = "\n});";
// Where the wrapper's function ends in the text that is parsed: just after its closing brace.
const endOfWrapper = (code: string) => BEFORE.length + code.length + "\n}".length;

function walk(node: unknown, visit: (node: Node) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const typed = node as Node & Record<string, unknown>;
  if (typeof typed.type === "string") visit(typed);
  for (const [key, value] of Object.entries(typed)) {
    if (key !== "type" && typeof value === "object" && value !== null) walk(value, visit);
  }
}

export function assertPieceCode(code: string): void {
  let program: Node & { body: (Node & { expression?: Node & { body?: Node } })[] };
  try {
    program = parse(BEFORE + code + AFTER, { ecmaVersion: "latest", sourceType: "script" }) as typeof program;
  } catch (err) {
    const where = err instanceof SyntaxError ? err.message.replace(/\s*\(\d+:\d+\)$/, "") : "it could not be read";
    throw new PieceCodeError(`The code is not valid JavaScript: ${where}.`);
  }
  const [only] = program.body;
  const wrapper = only?.type === "ExpressionStatement" ? only.expression : undefined;
  // The wrapper must be the only statement, and must end where the wrapper ends: nothing of the piece outside it.
  if (program.body.length !== 1 || wrapper?.type !== "FunctionExpression" || wrapper.end !== endOfWrapper(code)) {
    throw new PieceCodeError("The code must be plain statements that call define({ ... }). It may not close the function it is placed in.");
  }
  walk(wrapper.body, (node) => {
    if (node.type === "ImportExpression") throw new PieceCodeError("The code may not use import(). A piece is plain calculation and loads nothing.");
  });
}
