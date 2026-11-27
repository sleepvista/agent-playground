// Proves, in a real browser, two things a security review found missing.
//
// 1. A project piece cannot reach anything but the language's building blocks:
//    not the canvas the finished project draws on, not the worker it runs in,
//    not timers or messages, and it cannot alter the building blocks to
//    interfere with the program beside it. A piece that tries is accepted only
//    if every attempt fails, and the finished project then runs untouched.
// 2. A build that floods the page with messages is shut down.
//
// Run with: npm run test:isolation   (needs Playwright's Chromium available)
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import zlib from "node:zlib";

const { chromium } = createRequire(import.meta.url)("playwright");
const root = path.resolve(import.meta.dirname, "../..");
const PORT = 8796;
const GALLERY = `http://localhost:${PORT}`;
const SANDBOX = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = "isolation-test-admin-token-0123456789abcdef";
const persistDir = path.join(root, ".wrangler/isolation-test");

const failures = [];
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures.push(label);
};

// A piece that gives right answers and, when loaded and again every time it is
// called, tries everything it can think of. `reached()` lists what worked.
const HOSTILE = `
const found = [];
const attempt = (label, action) => { try { if (action()) found.push(label); } catch {} };
const probe = (when) => {
  for (const [name, seen] of [
    ["self", typeof self], ["globalThis", typeof globalThis], ["postMessage", typeof postMessage], ["setTimeout", typeof setTimeout],
    ["setInterval", typeof setInterval], ["canvas", typeof canvas], ["on", typeof on], ["view", typeof view], ["keys", typeof keys],
    ["OffscreenCanvas", typeof OffscreenCanvas], ["importScripts", typeof importScripts], ["fetch", typeof fetch], ["URL", typeof URL],
    ["Blob", typeof Blob], ["Worker", typeof Worker], ["console", typeof console], ["navigator", typeof navigator],
    ["requestAnimationFrame", typeof requestAnimationFrame], ["addEventListener", typeof addEventListener], ["onmessage", typeof onmessage],
    ["Function", typeof Function], ["Proxy", typeof Proxy], ["Promise", typeof Promise], ["Date", typeof Date], ["eval", typeof eval],
    ["__pieceNames", typeof __pieceNames], ["__start", typeof __start], ["engine", typeof engine], ["location", typeof location],
  ]) {
    if (seen !== "undefined") found.push(when + ":" + name);
  }
  attempt(when + ":this", () => (function () { return this; })() !== undefined);
  attempt(when + ":code-from-text", () => (function () {}).constructor("return this")() !== undefined);
  attempt(when + ":async-code-from-text", () => (async function () {}).constructor("return 1") !== undefined);
  attempt(when + ":new-global", () => { leaked = 1; return true; });
  attempt(when + ":caller", () => probe.caller !== undefined);
};
probe("load");
const everyFunction = Object.getPrototypeOf(function () {});
const before = [Array.prototype.push, Object.prototype.toString, Math.max, JSON.stringify, everyFunction.call];
attempt("patch-array", () => { Array.prototype.push = function () { return 0; }; return Array.prototype.push !== before[0]; });
attempt("patch-object", () => { Object.prototype.planted = 1; return ({}).planted === 1; });
attempt("patch-object-accessor", () => { Object.defineProperty(Object.prototype, "x", { set() {} }); return true; });
attempt("patch-math", () => { Math.max = () => 0; return Math.max !== before[2]; });
attempt("patch-json", () => { JSON.stringify = () => ""; return JSON.stringify !== before[3]; });
attempt("patch-call", () => { everyFunction.call = function () {}; return everyFunction.call !== before[4]; });
attempt("patch-iterator", () => { Object.getPrototypeOf([][Symbol.iterator]()).next = () => ({ done: true }); return [...[1]].length === 0; });
attempt("patch-string", () => { String.prototype.trim = () => "x"; return " a ".trim() === "x"; });
attempt("patch-typed", () => { Object.getPrototypeOf(Int8Array).prototype.planted = 1; return new Int8Array(1).planted === 1; });
define({
  sum: (a, b) => a + b,
  reached: () => { probe("call"); return [...new Set(found)]; },
});`;
const KEY = "define({ sum: (a, b) => a + b, reached: () => [] });";
// The finished project's own program. It needs everything a build gets, handed to it directly.
// Green means the hostile piece reached nothing; red means it did. It never draws anything else.
const SHOWCASE = `
const ctx = canvas.getContext("2d");
let reached = ["not asked yet"];
on("frame", () => {
  reached = engine.hostile.reached();
  const fine = reached.length === 0 && engine.plain.double(4) === 8 && view.width > 0 && keys.size === 0 && pointer.down === false;
  ctx.fillStyle = fine ? "#00ff00" : "#ff0000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
});`;
const tests = (call, args, expect) => ({ name: `${call} check`, call, args, expect });
const CONTENT = {
  project: { id: "boxed", title: "A boxed project", summary: "Two pieces, one of them hostile." },
  pieces: [
    {
      id: "hostile",
      title: "Sums",
      summary: "Adds two numbers.",
      spec: "Write sum(a, b) and reached().",
      public_tests: [tests("sum", [1, 2], 3)],
      hidden_tests: [tests("sum", [5, 5], 10), tests("reached", [], [])],
      reference_code: KEY,
    },
    {
      id: "plain",
      title: "Doubling",
      summary: "Doubles a number.",
      spec: "Write double(n).",
      public_tests: [tests("double", [2], 4)],
      hidden_tests: [tests("double", [5], 10)],
      reference_code: "define({ double: (n) => n * 2 });",
    },
  ],
  showcase: { title: "The boxed program", note: "Green when the pieces behaved.", code: SHOWCASE },
};
const BY_PIECE = { hostile: HOSTILE, plain: "define({ double: (n) => n * 2 });" };

/** The colour of the pixel in the middle of a PNG screenshot, as [red, green, blue]. */
function middlePixel(png) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const channels = { 2: 3, 6: 4 }[png[25]];
  const chunks = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    if (png.toString("latin1", at + 4, at + 8) === "IDAT") chunks.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    const above = rows[y - 1];
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? line[x - channels] : 0;
      const up = above ? above[x] : 0;
      const upLeft = above && x >= channels ? above[x - channels] : 0;
      const paeth = () => {
        const p = left + up - upLeft;
        const [a, b, c] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
        return a <= b && a <= c ? left : b <= c ? up : upLeft;
      };
      line[x] = (line[x] + [0, left, up, (left + up) >> 1, paeth()][filter]) & 255;
    }
    rows.push(line);
  }
  const middle = rows[height >> 1];
  const at = (width >> 1) * channels;
  return [middle[at], middle[at + 1], middle[at + 2]];
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("exit", (code) => (code === 0 ? resolve(output) : reject(new Error(output))));
  });
}

async function api(pathname, { body, key, ip, method } = {}) {
  const response = await fetch(GALLERY + pathname, {
    method: method ?? (body ? "POST" : "GET"),
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(ip ? { "CF-Connecting-IP": ip } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${pathname}: ${JSON.stringify(data)}`);
  return data;
}

let server;
let browser;
try {
  rmSync(persistDir, { recursive: true, force: true });
  await run(["wrangler", "d1", "migrations", "apply", "DB", "--local", "--persist-to", persistDir]);
  server = spawn(
    "npx",
    [
      "wrangler", "dev", "--port", String(PORT), "--ip", "0.0.0.0", "--persist-to", persistDir,
      "--var", `GALLERY_ORIGIN:${GALLERY}`, "--var", `SANDBOX_ORIGIN:${SANDBOX}`, "--var", `ADMIN_TOKEN:${ADMIN_TOKEN}`,
    ],
    { cwd: root, stdio: "ignore", detached: true },
  );
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${GALLERY}/api/v1/status`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (i > 120) throw new Error("wrangler dev did not start");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await api("/api/admin/settings", { key: ADMIN_TOKEN, body: { registrations_open: true, submissions_open: true, work_open: true } });
  await api("/api/admin/content", { key: ADMIN_TOKEN, body: CONTENT });

  // Both pieces are handed in and judged through the front door.
  for (const [index, name] of ["builder-a", "builder-b"].entries()) {
    const ip = `192.0.2.${index + 1}`;
    const agent = await api("/api/v1/agents", { body: { name }, ip });
    const taken = await api("/api/v1/work/claim", { key: agent.api_key, ip, method: "POST" });
    await api("/api/v1/work/submit", { key: agent.api_key, ip, body: { code: BY_PIECE[taken.work.piece.id] } });
  }
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
  await page.goto(`${GALLERY}/admin`);
  await page.fill("input[type=password]", ADMIN_TOKEN);
  await page.click("button.primary");
  await page.waitForFunction(() => [...document.querySelectorAll(".item p[role=status]")].filter((p) => /Passed/.test(p.textContent)).length === 2, null, { timeout: 60_000 });
  const verdicts = await page.$$eval(".item", (nodes) => nodes.filter((n) => n.querySelector("iframe.checks")).map((n) => `${n.querySelector("h3").textContent}: ${n.querySelector("p[role=status]").textContent}`));

  console.log("\nA piece that tries to reach beyond its own calculation:");
  const judgedClean = verdicts.some((line) => /Sums: Passed all 3 checks/.test(line));
  let reachedWhileJudged = "";
  if (!judgedClean) {
    // Says what it reached, by loading the piece once more the same way inside a checks frame.
    const checksFrame = page.frames().find((candidate) => candidate.url().startsWith(`${SANDBOX}/t/`));
    reachedWhileJudged = await checksFrame.evaluate(
      (code) =>
        new Promise((resolve) => {
          const inside = () => {
            const load = pieceWorkerSetup();
            self.onmessage = (event) => {
              try {
                postMessage(JSON.stringify(load(event.data).reached()));
              } catch (error) {
                postMessage("error: " + error.message);
              }
            };
          };
          const worker = new Worker(URL.createObjectURL(new Blob([`${pieceWorkerSetup}\n(${inside})();`], { type: "text/javascript" })));
          worker.onmessage = (event) => resolve(event.data);
          worker.onerror = (event) => resolve("worker error: " + event.message);
          worker.postMessage(code);
        }),
      HOSTILE,
    );
  }
  check("reaches nothing while it is judged, so it passes", judgedClean, `${verdicts.join(" | ")} ${reachedWhileJudged}`);
  if (!judgedClean) throw new Error("the hostile piece was not accepted, so the rest cannot be tested");
  for (let i = 0; i < 2; i++) {
    await page.locator(".item:has(iframe.checks) button:has-text('Accept into the project')").first().click();
    await page.waitForTimeout(1500);
  }
  const progress = await api("/api/v1/projects/boxed");
  check("both pieces are accepted and the project is complete", progress.complete === true);

  await page.goto(`${GALLERY}/projects/boxed`);
  const frame = page.locator(".frame-wrap iframe");
  await frame.scrollIntoViewIfNeeded();
  await page.waitForTimeout(2500);
  const [red, green, blue] = middlePixel(await frame.screenshot());
  check("reaches nothing while the finished project runs: no canvas, no worker, no timers, no altered building blocks", green > 200 && red < 60 && blue < 60, `the program drew rgb(${red}, ${green}, ${blue})`);
  const inner = page.frames().find((candidate) => candidate.url().startsWith(`${SANDBOX}/p/`));
  check("the finished project is still running, with no error notice", inner && (await inner.locator("#notice").isHidden()));

  console.log("\nA build that floods the page with messages:");
  const ip = "192.0.2.9";
  const flooder = await api("/api/v1/agents", { body: { name: "flooder" }, ip });
  const made = await api("/api/v1/builds", {
    key: flooder.api_key,
    ip,
    body: { title: "A flood", note: "", code: 'canvas.getContext("2d"); on("frame", () => { for (let i = 0; i < 5000; i++) postMessage({ type: "ack" }); });' },
  });
  await api(`/api/admin/builds/${made.build.id}`, { key: ADMIN_TOKEN, body: { action: "approve" } });
  await page.goto(`${GALLERY}/build/${made.build.id}`);
  const build = page.frames().find((candidate) => candidate.url().startsWith(`${SANDBOX}/b/`));
  await build.locator("#notice").waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
  const notice = (await build.locator("#notice").isVisible()) ? await build.locator("#notice").textContent() : "(no notice)";
  check("is shut down", /far more messages/.test(notice), notice);
} catch (error) {
  failures.push("test run crashed");
  console.error(error);
} finally {
  await browser?.close();
  if (server) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

console.log(failures.length === 0 ? "\nIsolation held." : `\n${failures.length} check(s) FAILED: ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
