// Proves the sandbox in a real browser. Submits deliberately hostile builds,
// opens them in the gallery, and checks that every escape attempt failed,
// that a hung or broken build is shut down, and that a stand-in "attacker
// server" never received a single request or packet.
//
// Run with: npm run test:browser   (needs Playwright's Chromium available)
//
// By default it starts a throwaway local copy. To check a deployed site, set
// TARGET_GALLERY, TARGET_SANDBOX and TARGET_ADMIN_TOKEN. Against a deployed
// site it opens submissions for the length of the run, then puts the settings
// back and bans the test agents it created.
import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import dgram from "node:dgram";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";

const { chromium } = createRequire(import.meta.url)("playwright");

const root = path.resolve(import.meta.dirname, "../..");
const PORT = 8791;
const CANARY_PORT = 8792;
const PROBE_PORT = 8793;
const live = Boolean(process.env.TARGET_GALLERY);
const GALLERY = process.env.TARGET_GALLERY ?? `http://localhost:${PORT}`;
const SANDBOX = process.env.TARGET_SANDBOX ?? `http://127.0.0.1:${PORT}`;
const CANARY = `http://localhost:${CANARY_PORT}`;
const ADMIN_TOKEN = process.env.TARGET_ADMIN_TOKEN ?? "containment-admin-token-0123456789abcdef";
const runId = Date.now().toString(36);
const persistDir = path.join(root, ".wrangler/containment-test");

const failures = [];
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures.push(label);
};

// The attacker's server. Any request under /hit means data or traffic got out.
const hits = [];
const canary = createServer((request, response) => {
  if (request.url.startsWith("/hit")) hits.push(`${request.method} ${request.url}`);
  if (request.url.startsWith("/embed")) {
    const target = new URL(request.url, CANARY).searchParams.get("src");
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(`<!doctype html><title>attacker page</title><iframe id="x" src="${target}"></iframe>`);
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html", "Access-Control-Allow-Origin": "*" });
  response.end("<!doctype html><title>attacker</title><h1 id='attacker'>attacker content</h1>");
});
canary.on("upgrade", (request, socket) => {
  hits.push(`UPGRADE ${request.url}`);
  socket.destroy();
});
// A second listener for traffic that is not HTTP at all, such as WebRTC.
const probeTcp = net.createServer((socket) => {
  hits.push("raw TCP connection");
  socket.destroy();
});
const probeUdp = dgram.createSocket("udp4");
probeUdp.on("message", () => hits.push("raw UDP packet"));

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("exit", (code) => (code === 0 ? resolve(output) : reject(new Error(output))));
  });
}

async function waitForServer() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${GALLERY}/api/v1/status`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("wrangler dev did not start");
}

async function api(pathname, { body, key, ip } = {}) {
  const response = await fetch(GALLERY + pathname, {
    method: body ? "POST" : "GET",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      // A deployed site sits behind Cloudflare, which rejects any request that tries to supply this header.
      ...(ip && !live ? { "CF-Connecting-IP": ip } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${pathname}: ${JSON.stringify(data)}`);
  return data;
}

let server;
let browser;
let settingsBefore;
const createdAgents = [];
try {
  await new Promise((resolve) => canary.listen(CANARY_PORT, resolve));
  await new Promise((resolve) => probeTcp.listen(PROBE_PORT, resolve));
  await new Promise((resolve) => probeUdp.bind(PROBE_PORT, resolve));
  if (!live) {
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
  }
  await waitForServer();

  // Seed: open the site, then submit and approve three bad builds.
  settingsBefore = (await api("/api/admin/overview", { key: ADMIN_TOKEN })).settings;
  await api("/api/admin/settings", { key: ADMIN_TOKEN, body: { registrations_open: true, submissions_open: true } });
  let seeded = 0;
  async function publish(label, code) {
    const name = `${label}-${runId}`;
    const ip = `192.0.2.${++seeded}`; // only a local copy accepts a made-up address
    const agent = await api("/api/v1/agents", { body: { name }, ip });
    createdAgents.push(agent.agent.id);
    const { build } = await api("/api/v1/builds", { key: agent.api_key, ip, body: { title: name, note: "", code } });
    await api(`/api/admin/builds/${build.id}`, { key: ADMIN_TOKEN, body: { action: "approve" } });
    return build.id;
  }
  const hostile = readFileSync(path.join(import.meta.dirname, "hostile-build.js"), "utf8")
    .replaceAll("__CANARY__", CANARY)
    .replaceAll("__PROBE__", `127.0.0.1:${PROBE_PORT}`)
    .replaceAll("__GALLERY__", GALLERY);
  const id = await publish("red-team", hostile);
  const hangId = await publish("hangs-forever", 'canvas.getContext("2d"); on("frame", () => { for (;;) {} });');
  const crashId = await publish("throws-error", 'canvas.getContext("2d"); on("frame", () => { throw new Error("boom"); });');

  const proxy = live && process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1" } : undefined;
  browser = await chromium.launch({ proxy });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const popups = [];
  const dialogs = [];
  const downloads = [];
  context.on("page", (opened) => opened !== page && popups.push(opened.url()));
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message());
    dialog.dismiss().catch(() => {});
  });
  page.on("download", (download) => downloads.push(download.suggestedFilename()));

  console.log("\nA hostile build, viewed in the gallery:");
  await page.goto(`${GALLERY}/build/${id}`);
  let results;
  let drew = false;
  for (let i = 0; i < 60 && !results; i++) {
    await page.waitForTimeout(500);
    for (const worker of page.workers()) {
      const state = await worker.evaluate(() => (self.__results && self.__results.__done ? { results: self.__results, drew: self.__drew === true } : null)).catch(() => null);
      if (state) ({ results, drew } = state);
    }
  }
  if (!results) throw new Error("the hostile build never finished");
  delete results.__done;
  for (const [name, outcome] of Object.entries(results)) check(name, outcome === "blocked", outcome);
  check("the build ran and made every attempt", Object.keys(results).length === 24, `${Object.keys(results).length} of 24 attempts`);
  check("the build could still draw on its canvas", drew);

  const frame = page.frames().find((f) => f.url().startsWith(SANDBOX));
  const hostPage = await frame.evaluate(() => ({
    title: document.title,
    scripts: document.scripts.length,
    images: document.images.length,
    notice: document.getElementById("notice").hidden,
  }));
  check("markup hidden in the code did not become part of the page", hostPage.title === "Build" && hostPage.scripts === 3 && hostPage.images === 0, JSON.stringify(hostPage));
  check("gallery page was not navigated away", page.url() === `${GALLERY}/build/${id}`, page.url());
  check("no popup windows", popups.length === 0, popups.join(", "));
  check("no dialogs", dialogs.length === 0, dialogs.join(", "));
  check("no downloads", downloads.length === 0, downloads.join(", "));

  console.log("\nA build that hangs forever:");
  await page.goto(`${GALLERY}/build/${hangId}`);
  const hangNotice = page.frameLocator("article.build iframe").locator("#notice");
  await hangNotice.filter({ hasText: "stopped responding" }).waitFor({ timeout: 15_000 }).catch(() => {});
  check("is shut down with a notice", (await hangNotice.textContent()).includes("stopped responding"));
  await page.locator("details.report summary").click();
  check("the page around it still works", await page.locator("#report-send").isVisible());

  console.log("\nA build that crashes:");
  await page.goto(`${GALLERY}/build/${crashId}`);
  const crashNotice = page.frameLocator("article.build iframe").locator("#notice");
  await crashNotice.filter({ hasText: "error" }).waitFor({ timeout: 15_000 }).catch(() => {});
  check("is stopped with a notice", (await crashNotice.textContent()).includes("error in its code"));

  console.log("\nOpening the build's address directly:");
  const direct = await context.newPage();
  await direct.goto(`${SANDBOX}/b/${id}`);
  check("redirects to the gallery page", direct.url() === `${GALLERY}/build/${id}`, direct.url());
  await direct.close();

  console.log("\nAnother website tries to embed the build and the gallery:");
  const attacker = await context.newPage();
  await attacker.goto(`${CANARY}/embed?src=${encodeURIComponent(`${SANDBOX}/b/${id}`)}`);
  await attacker.waitForTimeout(1000);
  check("build does not render on another site", (await attacker.frameLocator("#x").locator("#stage").count().catch(() => 0)) === 0);
  await attacker.goto(`${CANARY}/embed?src=${encodeURIComponent(GALLERY + "/")}`);
  await attacker.waitForTimeout(1000);
  check("gallery does not render on another site", (await attacker.frameLocator("#x").locator("header.site").count().catch(() => 0)) === 0);
  await attacker.close();

  console.log("\nThe attacker's server:");
  check("received no requests or packets at all", hits.length === 0, [...new Set(hits)].join(", "));
} catch (error) {
  failures.push("test run crashed");
  console.error(error);
} finally {
  await browser?.close();
  if (live && settingsBefore) {
    try {
      await api("/api/admin/settings", {
        key: ADMIN_TOKEN,
        body: { registrations_open: settingsBefore.registrations_open, submissions_open: settingsBefore.submissions_open },
      });
      for (const id of createdAgents) await api(`/api/admin/agents/${id}`, { key: ADMIN_TOKEN, body: { action: "ban" } });
      console.log("\nSite settings restored and test agents removed.");
    } catch (error) {
      failures.push("could not restore the site after the run");
      console.error(error);
    }
  }
  if (server) {
    try {
      process.kill(-server.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  canary.close();
  probeTcp.close();
  probeUdp.close();
}

console.log(failures.length === 0 ? "\nAll containment checks passed." : `\n${failures.length} check(s) FAILED: ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
