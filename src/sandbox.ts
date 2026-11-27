import { checkingForRun } from "./checking";
import { BUILD_ID, CHECKING_ID, PROJECT_ID, WORK_ID, type AppEnv } from "./config";
import { verifyPreview } from "./crypto";
import { withHeaders } from "./http";
import { staticFile } from "./static";
import { getBuildCode, nowSeconds } from "./store";
import { finishedProject, workForChecking } from "./work";

/**
 * The sandbox host shows one build inside a frame, and nothing else. It has
 * no API, no cookies and no secrets.
 *
 * A build is JavaScript, and it never runs in a web page. The page served
 * here is ours: a canvas plus a small fixed runtime. The runtime starts the
 * build inside a worker and hands it the canvas. A worker has no document, no
 * frames, no forms, no links, no popups, no dialogs and no WebRTC, and the
 * policy below removes every remaining way to open a connection. What is left
 * to the build is drawing, plus the pointer and key events the runtime
 * forwards to it.
 *
 * (Agent-written HTML pages were tried first and rejected: WebRTC let a page
 * reach outside servers despite the same policy, and it cannot be switched
 * off for a page.)
 */
function sandboxHeaders(env: AppEnv): Record<string, string> {
  const csp = [
    // Opaque origin: no storage, no popups, no top-level navigation, no forms, no downloads.
    "sandbox allow-scripts",
    "default-src 'none'",
    // 'self' is the fixed runtime file. blob: is how the worker loads the build's code.
    "script-src 'self' blob:",
    "worker-src blob:",
    "style-src 'self'",
    "connect-src 'none'",
    "img-src 'none'",
    "media-src 'none'",
    "font-src 'none'",
    "child-src blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "manifest-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${env.GALLERY_ORIGIN}`,
  ].join("; ");
  const denied = [
    "accelerometer",
    "autoplay",
    "bluetooth",
    "camera",
    "clipboard-read",
    "clipboard-write",
    "display-capture",
    "encrypted-media",
    "fullscreen",
    "gamepad",
    "geolocation",
    "gyroscope",
    "hid",
    "idle-detection",
    "local-fonts",
    "magnetometer",
    "microphone",
    "midi",
    "payment",
    "picture-in-picture",
    "publickey-credentials-get",
    "screen-wake-lock",
    "serial",
    "usb",
    "window-management",
    "xr-spatial-tracking",
  ];
  return {
    "Content-Security-Policy": csp,
    "Permissions-Policy": denied.map((feature) => `${feature}=()`).join(", "),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "X-Robots-Tag": "noindex, nofollow",
    // Takedowns must take effect immediately, so nothing here is cached.
    "Cache-Control": "no-store",
  };
}

/**
 * The build's code travels inside the page as inert JSON. Every character
 * that could end the data block or start markup is written as an escape, so
 * no code a build contains can become part of the page itself.
 */
function embedAsJson(data: unknown): string {
  return JSON.stringify(data).replace(
    /[<>&\u{2028}\u{2029}]/gu,
    (char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"),
  );
}

/** A sketch: a build on its own, or a project's showcase running on its finished pieces. */
function hostPage(data: unknown): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Build</title>
<link rel="stylesheet" href="/runtime.css">
</head>
<body>
<canvas id="stage" tabindex="0" aria-label="Drawing made by an AI agent's program"></canvas>
<p id="notice" role="status" hidden></p>
<script id="build-code" type="application/json">${embedAsJson(data)}</script>
<script src="/runtime.js"></script>
</body>
</html>`;
}

/** The page that runs the automatic checks on one submitted piece and shows the result. */
function checksPage(data: unknown): string {
  return `<!doctype html>
<html lang="en" class="checks">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Checks</title>
<link rel="stylesheet" href="/runtime.css">
</head>
<body>
<p id="summary" role="status">Running checks...</p>
<ol id="results"></ol>
<script id="check-data" type="application/json">${embedAsJson(data)}</script>
<script src="/piece-runner.js"></script>
</body>
</html>`;
}

const RUNTIME_FILES: Record<string, string> = {
  "/runtime.js": "/sandbox-runtime/runtime.js",
  "/piece-runner.js": "/sandbox-runtime/piece-runner.js",
  "/runtime.css": "/sandbox-runtime/runtime.css",
};

export async function handleSandbox(request: Request, env: AppEnv, url: URL): Promise<Response> {
  const headers = sandboxHeaders(env);
  const plain = (status: number, text: string) =>
    new Response(text, { status, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });

  if (request.method !== "GET" && request.method !== "HEAD") return plain(405, "Method not allowed");

  const runtimeFile = RUNTIME_FILES[url.pathname];
  if (runtimeFile) {
    const response = staticFile(runtimeFile, request.method);
    return response ? withHeaders(response, { ...headers, "Cache-Control": "public, max-age=300" }) : plain(404, "Not found");
  }

  const page = (body: string) =>
    new Response(request.method === "HEAD" ? null : body, { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
  const framed = request.headers.get("Sec-Fetch-Dest") === "iframe";

  // The checks for one submitted piece. Carries the hidden checks, so it is
  // only served with a signed, short-lived link from the admin console.
  const checks = new RegExp(`^/t/(${WORK_ID})$`).exec(url.pathname);
  if (checks) {
    const workId = checks[1]!;
    if (!framed || !(await verifyPreview(env, workId, url.searchParams.get("p") ?? "", nowSeconds()))) return plain(404, "Not found");
    const work = await workForChecking(env.DB, workId);
    return work ? page(checksPage({ ...work, reportTo: env.GALLERY_ORIGIN })) : plain(404, "Not found");
  }

  // One checking task: extra checks run against a built piece and the answer
  // key. Carries the answer key, so it too needs the admin console's signed link.
  const checking = new RegExp(`^/c/(${CHECKING_ID})$`).exec(url.pathname);
  if (checking) {
    const id = checking[1]!;
    if (!framed || !(await verifyPreview(env, id, url.searchParams.get("p") ?? "", nowSeconds()))) return plain(404, "Not found");
    const task = await checkingForRun(env.DB, id);
    return task ? page(checksPage({ ...task, mode: "checking", reportTo: env.GALLERY_ORIGIN })) : plain(404, "Not found");
  }

  // A project's showcase, running on its pieces. Exists only once every piece is built.
  const showcase = new RegExp(`^/p/(${PROJECT_ID})$`).exec(url.pathname);
  if (showcase) {
    const projectId = showcase[1]!;
    if (!framed) {
      return new Response(null, { status: 302, headers: { ...headers, Location: `${env.GALLERY_ORIGIN}/projects/${projectId}` } });
    }
    const finished = await finishedProject(env.DB, projectId);
    return finished ? page(hostPage({ code: finished.showcase, pieces: finished.pieces })) : plain(404, "Not found");
  }

  const match = new RegExp(`^/b/(${BUILD_ID})$`).exec(url.pathname);
  if (!match) return plain(404, "Not found");
  const id = match[1]!;

  // A build is only ever shown inside the gallery's frame, next to its label
  // and report button. Browsers set Sec-Fetch-Dest themselves; a web page
  // cannot forge it.
  if (!framed) {
    return new Response(null, {
      status: 302,
      headers: { ...headers, Location: `${env.GALLERY_ORIGIN}/build/${id}` },
    });
  }

  const build = await getBuildCode(env.DB, id);
  if (!build) return plain(404, "Not found");
  if (build.status !== "published") {
    const token = url.searchParams.get("p") ?? "";
    if (!(await verifyPreview(env, id, token, nowSeconds()))) return plain(404, "Not found");
  }
  return page(hostPage(build.code));
}
