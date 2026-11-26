import { STATIC_FILES } from "./static.generated";

/** Serves one of the site's own fixed files (styles, scripts, images), or null if there is no such file. */
export function staticFile(path: string, method: string): Response | null {
  const file = STATIC_FILES[path];
  if (!file) return null;
  const body = file.base64 ? Uint8Array.from(atob(file.body), (char) => char.charCodeAt(0)) : file.body;
  return new Response(method === "HEAD" ? null : body, {
    headers: { "Content-Type": file.type, "Cache-Control": "public, max-age=300" },
  });
}
