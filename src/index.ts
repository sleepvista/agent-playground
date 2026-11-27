import { handleApi } from "./api";
import type { AppEnv } from "./config";
import { json, withHeaders } from "./http";
import { handlePage } from "./pages";
import { handleSandbox } from "./sandbox";
import { cleanup, nowSeconds } from "./store";

/**
 * Headers for the gallery host: pages, API and static files. Only this
 * site's own scripts and styles run, and the only thing a page may frame is
 * the sandbox host. frame-src also governs where a framed build can navigate
 * itself, so a build cannot swap itself for another website inside the frame.
 */
function galleryHeaders(env: AppEnv): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Security-Policy": [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self'",
      "connect-src 'self'",
      `frame-src ${env.SANDBOX_ORIGIN}`,
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; "),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  };
  if (env.GALLERY_ORIGIN.startsWith("https://")) {
    headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }
  return headers;
}

function validOrigin(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    try {
      // The isolation between the two hosts is the core of the design, so a
      // deployment where they are missing or identical serves nothing at all.
      if (!validOrigin(env.GALLERY_ORIGIN) || !validOrigin(env.SANDBOX_ORIGIN) || env.GALLERY_ORIGIN === env.SANDBOX_ORIGIN) {
        return json({ error: { code: "not_configured", message: "The site is not configured." } }, 503);
      }
      const url = new URL(request.url);
      if (url.origin === env.SANDBOX_ORIGIN) return await handleSandbox(request, env, url);
      if (url.origin === env.GALLERY_ORIGIN) {
        const response = url.pathname.startsWith("/api/")
          ? await handleApi(request, env, url)
          : await handlePage(request, env, url);
        return withHeaders(response, galleryHeaders(env));
      }
      // A person who typed the address without "https" is sent to the secure site. Only page visits:
      // an API request sent in the clear has already exposed whatever it carried, and is not answered.
      const secure = `https://${url.host}`;
      const pageVisit = (request.method === "GET" || request.method === "HEAD") && !url.pathname.startsWith("/api/");
      if (url.protocol === "http:" && pageVisit && (secure === env.GALLERY_ORIGIN || secure === env.SANDBOX_ORIGIN)) {
        return new Response(null, { status: 308, headers: { Location: secure + url.pathname + url.search } });
      }
      return new Response("Not found", { status: 404 });
    } catch (err) {
      console.error("unhandled error", err instanceof Error ? (err.stack ?? err.message) : String(err));
      return json({ error: { code: "internal_error", message: "Something went wrong on our side." } }, 500);
    }
  },

  async scheduled(_controller: ScheduledController, env: AppEnv, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(cleanup(env.DB, nowSeconds()));
  },
} satisfies ExportedHandler<AppEnv>;
