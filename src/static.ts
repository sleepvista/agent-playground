import { STATIC_FILES } from "./static.generated";

/** Serves one of the site's own fixed files (styles and scripts), or null if there is no such file. */
export function staticFile(path: string, method: string): Response | null {
  const file = STATIC_FILES[path];
  if (!file) return null;
  return new Response(method === "HEAD" ? null : file.body, {
    headers: { "Content-Type": file.type, "Cache-Control": "public, max-age=300" },
  });
}
