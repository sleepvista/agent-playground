// Builds the engine project's content from a private folder and, optionally,
// loads it into a running site. The content itself (task texts, reference
// answers, hidden checks) is deliberately not part of this repository.
//
//   node scripts/load-content.mjs <folder> --out content.json
//   node scripts/load-content.mjs <folder> --target https://site --token <admin token>
//
// Folder layout:
//   project.json                 { "pieces": ["id", ...], "showcase": { "title", "note" } }
//   showcase.js                  the program that runs on the finished engine
//   pieces/<id>/meta.json        { "title", "summary" }
//   pieces/<id>/spec.md          what the agent is asked to write
//   pieces/<id>/reference.js     a correct answer, used only to work out expected results
//   pieces/<id>/tests.mjs        exports publicCalls and hiddenCalls: [{ name, call, args, tol?, judge? }]
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [folder, ...flags] = process.argv.slice(2);
const flag = (name) => (flags.includes(name) ? flags[flags.indexOf(name) + 1] : undefined);
if (!folder) throw new Error("usage: node scripts/load-content.mjs <folder> [--out file] [--target url --token token]");
const read = (...parts) => readFileSync(path.join(folder, ...parts), "utf8");

const PREAMBLE = `You are writing one piece of a small 2D game engine. Other agents are writing the other pieces; you will not see their work and they will not see yours.

Write plain JavaScript that calls define({ ... }) exactly once, passing the functions listed below under exactly these names.

Rules for every function:
- It is pure calculation: values in, a new value out.
- Never change an argument. Return new objects and arrays.
- Keep nothing between calls. No globals, no Date, no Math.random, no timers, no network.
- Use only plain objects, arrays, numbers, booleans, strings and null.
- Return objects with exactly the fields described and no others.
- Coordinates: x grows to the right, y grows downward. Angles are in radians.

`;

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function jsonSafe(value, where) {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error(`${where}: the reference returned something JSON cannot hold`);
  const back = JSON.parse(text);
  const check = (a, b) => {
    if (typeof a === "number" && !Number.isFinite(a)) throw new Error(`${where}: non-finite number in the expected result`);
    if (a !== null && typeof a === "object") {
      for (const key of Object.keys(a)) {
        if (a[key] === undefined) throw new Error(`${where}: undefined field "${key}" in the expected result`);
        check(a[key], b[key]);
      }
    }
  };
  check(value, back);
  return back;
}

async function buildPiece(id) {
  const meta = JSON.parse(read("pieces", id, "meta.json"));
  const reference = read("pieces", id, "reference.js");
  let functions = null;
  new Function("define", `"use strict";\n${reference}`)((value) => (functions = value));
  if (!functions) throw new Error(`${id}: the reference never called define()`);
  const { publicCalls, hiddenCalls } = await import(pathToFileURL(path.resolve(folder, "pieces", id, "tests.mjs")).href);

  const finish = (calls, kind) =>
    calls.map((test) => {
      const where = `${id} / ${test.name}`;
      if (typeof functions[test.call] !== "function") throw new Error(`${where}: the reference has no function ${test.call}`);
      // Frozen arguments make the reference fail loudly if it changes its inputs.
      const run = () => functions[test.call](...deepFreeze(structuredClone(test.args)));
      const result = jsonSafe(run(), where);
      if (JSON.stringify(result) !== JSON.stringify(jsonSafe(run(), where))) throw new Error(`${where}: the reference is not repeatable`);
      const out = { name: test.name, call: test.call, args: test.args };
      if (test.tol !== undefined) out.tol = test.tol;
      if (test.judge === "gridPath") out.judge = { type: "gridPath", length: result === null ? null : result.length - 1 };
      else out.expect = result;
      if (kind === "hidden" && calls.length < 3) throw new Error(`${id}: too few hidden checks`);
      return out;
    });

  return {
    id,
    title: meta.title,
    summary: meta.summary,
    spec: PREAMBLE + read("pieces", id, "spec.md").trim() + "\n",
    public_tests: finish(publicCalls, "public"),
    hidden_tests: finish(hiddenCalls, "hidden"),
    reference_code: reference,
  };
}

const project = JSON.parse(read("project.json"));
const content = {
  pieces: await Promise.all(project.pieces.map(buildPiece)),
  showcase: { ...project.showcase, code: read("showcase.js") },
};
for (const piece of content.pieces) {
  console.log(`${piece.id}: ${piece.public_tests.length} examples, ${piece.hidden_tests.length} hidden checks, spec ${piece.spec.length} chars`);
}

if (flag("--out")) {
  writeFileSync(flag("--out"), JSON.stringify(content));
  console.log("wrote", flag("--out"));
}
if (flag("--target")) {
  const response = await fetch(`${flag("--target")}/api/admin/content`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${flag("--token")}` },
    body: JSON.stringify(content),
  });
  console.log("loaded:", response.status, await response.text());
  if (!response.ok) process.exit(1);
}
