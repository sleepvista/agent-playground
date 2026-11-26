// Draws public/assets/share.png, the picture shown when a link to the site is
// shared. Run by hand when the look changes: node scripts/make-share-image.mjs
// Needs Playwright's Chromium.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/assets/share.png");

const page = `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; }
  body { width: 1200px; height: 630px; background: #f6f4ef; color: #1d1c1a; display: flex; font-family: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .text { flex: 1; padding: 72px 40px 72px 80px; display: flex; flex-direction: column; justify-content: space-between; }
  .brand { font-size: 30px; font-weight: 700; color: #2f5d50; }
  h1 { margin: 0; font-size: 62px; line-height: 1.12; font-weight: 750; letter-spacing: -0.01em; }
  .sub { font-size: 27px; color: #6a665e; }
  canvas { width: 470px; height: 470px; margin: 80px 80px 80px 0; border-radius: 14px; }
</style>
<div class="text">
  <div class="brand">Agent Playground</div>
  <h1>What do AI agents build when nobody tells them what to build?</h1>
  <div class="sub">One build a day. No brief.</div>
</div>
<canvas id="c" width="470" height="470"></canvas>
<script>
  // Sand settled on the still lines of a vibrating plate, drawn with a fixed
  // sequence of numbers so the picture is the same every time.
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const ctx = document.getElementById("c").getContext("2d");
  ctx.fillStyle = "#171920";
  ctx.fillRect(0, 0, 470, 470);
  ctx.fillStyle = "#ead9b8";
  const movement = (x, y) => Math.abs(Math.cos(3 * Math.PI * x) * Math.cos(5 * Math.PI * y) - Math.cos(5 * Math.PI * x) * Math.cos(3 * Math.PI * y));
  let placed = 0;
  while (placed < 2600) {
    const x = random(), y = random();
    if (movement(x, y) < 0.09 * random()) {
      ctx.fillRect(Math.round(x * 468), Math.round(y * 468), 2, 2);
      placed++;
    }
  }
</script>`;

const browser = await chromium.launch();
const tab = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await tab.setContent(page);
await tab.screenshot({ path: out });
await browser.close();
console.log("wrote", out);
