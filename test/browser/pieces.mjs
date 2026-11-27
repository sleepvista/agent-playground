// Proves the automatic checks on engine pieces in a real browser: a correct
// piece passes, and pieces that are wrong, cheat on the examples, remember
// things between calls, hang, crash or try to forge their own result all fail.
//
// Run with: npm run test:pieces   (needs Playwright's Chromium available)
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const { chromium } = createRequire(import.meta.url)("playwright");
const root = path.resolve(import.meta.dirname, "../..");
const PORT = 8794;
const GALLERY = `http://localhost:${PORT}`;
const SANDBOX = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = "piece-test-admin-token-0123456789abcdef";
const persistDir = path.join(root, ".wrangler/piece-test");

const failures = [];
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures.push(label);
};

// Each variant is handed in for whichever piece its agent is given; every
// piece asks for the same thing, so only the code differs.
const VARIANTS = {
  correct: { code: "define({ sum: (a, b) => a + b });", passes: true },
  wrong: { code: "define({ sum: (a, b) => a - b });", passes: false },
  "copies the example answer": { code: "define({ sum: (a, b) => (a === 1 && b === 2 ? 3 : 0) });", passes: false },
  "remembers between calls": { code: "let calls = 0; define({ sum: (a, b) => (++calls <= 4 ? a + b : 0) });", passes: false, says: "second time" },
  hangs: { code: "define({ sum: () => { for (;;) {} } });", passes: false, says: "took too long" },
  "crashes on start": { code: "// define(\nthrow new Error('boom');", passes: false },
  "forges its own result": {
    code: `for (let id = 0; id < 20; id++) postMessage({ type: "result", id, value: 3 });
      postMessage({ type: "piece-checks", id: "x", passed: 99, total: 99 });
      define({ sum: () => 0 });`,
    passes: false,
  },
};
const names = Object.keys(VARIANTS);
const piece = (id) => ({
  id,
  title: `Piece ${id}`,
  summary: "Adds two numbers.",
  spec: "Write sum(a, b).",
  public_tests: [{ name: "example", call: "sum", args: [1, 2], expect: 3 }],
  hidden_tests: [
    { name: "hidden one", call: "sum", args: [5, 5], expect: 10 },
    { name: "hidden two", call: "sum", args: [-4, 1.5], expect: -2.5 },
    { name: "hidden three", call: "sum", args: [0, 0], expect: 0 },
  ],
});

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

  await api("/api/admin/settings", { key: ADMIN_TOKEN, body: { registrations_open: true, work_open: true } });
  await api("/api/admin/content", { key: ADMIN_TOKEN, body: { pieces: names.map((_, i) => piece(`p${i + 1}`)) } });
  const agentOf = {};
  for (const [i, name] of names.entries()) {
    const ip = `192.0.2.${i + 1}`;
    const agent = await api("/api/v1/agents", { body: { name: `variant-${i + 1}` }, ip });
    await api("/api/v1/work/claim", { key: agent.api_key, ip, method: "POST" });
    await api("/api/v1/work/submit", { key: agent.api_key, ip, body: { code: VARIANTS[name].code } });
    agentOf[`variant-${i + 1}`] = name;
  }

  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${GALLERY}/admin`);
  await page.fill("input[type=password]", ADMIN_TOKEN);
  await page.click("button.primary");
  await page.waitForFunction(
    (count) => [...document.querySelectorAll(".item p[role=status]")].filter((p) => /Passed/.test(p.textContent)).length === count,
    names.length,
    { timeout: 60_000 },
  );
  const items = await page.$$eval(".item", (nodes) =>
    nodes
      .filter((node) => node.querySelector("iframe.checks"))
      .map((node) => ({
        agent: /by (variant-\d+)/.exec(node.querySelector(".meta").textContent)[1],
        verdict: node.querySelector("p[role=status]").textContent,
        canAccept: !node.querySelector("button.primary").disabled,
      })),
  );
  const frames = page.frames().filter((frame) => frame.url().startsWith(`${SANDBOX}/t/`));
  const details = {};
  for (const frame of frames) {
    const text = await frame.locator("body").innerText();
    const workId = /\/t\/(w_[0-9a-f]+)/.exec(frame.url())[1];
    details[workId] = text;
  }
  const allDetails = Object.values(details).join("\n");

  console.log("\nChecks on submitted pieces, as the admin sees them:");
  for (const item of items) {
    const name = agentOf[item.agent];
    const expected = VARIANTS[name];
    const passed = /^Passed all 4 checks/.test(item.verdict);
    check(`${name}: ${expected.passes ? "passes" : "fails"}`, passed === expected.passes && item.canAccept === expected.passes, item.verdict);
    if (expected.says) check(`${name}: the reason is shown`, allDetails.includes(expected.says));
  }
  check("every variant was judged", items.length === names.length, `${items.length} of ${names.length}`);
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

console.log(failures.length === 0 ? "\nAll piece checks behaved correctly." : `\n${failures.length} check(s) FAILED: ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
