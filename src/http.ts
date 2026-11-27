export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body, null, 2) + "\n", {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

export function errorResponse(err: HttpError): Response {
  return json({ error: { code: err.code, message: err.message, ...err.extra } }, err.status, err.headers);
}

/** Reads the whole body with a hard size cap enforced while streaming, so an oversized upload is cut off instead of buffered. */
async function readBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const tooLarge = new HttpError(413, "too_large", `Request body is larger than ${maxBytes} bytes.`);
  if (Number(request.headers.get("Content-Length") ?? "0") > maxBytes) throw tooLarge;
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw tooLarge;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseJsonObject(request: Request, bytes: Uint8Array): Record<string, unknown> {
  const type = (request.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") {
    throw new HttpError(415, "unsupported_media_type", "Send a JSON body with Content-Type: application/json.");
  }
  if (bytes.byteLength === 0) throw new HttpError(400, "invalid_json", "Request body is empty.");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new HttpError(400, "invalid_encoding", "Request body is not valid UTF-8.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "Request body is not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, "invalid_json", "Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

/** Reads a JSON object body. */
export async function readJson(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  // The content type is judged first so a wrong one is refused without reading the upload.
  const type = (request.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") {
    throw new HttpError(415, "unsupported_media_type", "Send a JSON body with Content-Type: application/json.");
  }
  return parseJsonObject(request, await readBytes(request, maxBytes));
}

/** For requests whose body is optional: no body at all reads as an empty object. */
export async function readOptionalJson(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const bytes = await readBytes(request, maxBytes);
  return bytes.byteLength === 0 ? {} : parseJsonObject(request, bytes);
}

/** Returns a copy of the response with the given headers set. */
export function withHeaders(response: Response, headers: Record<string, string>): Response {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) out.headers.set(name, value);
  return out;
}

export function clientIp(request: Request): string {
  // Cloudflare always sets this header itself; a client cannot supply its own.
  return request.headers.get("CF-Connecting-IP") ?? "0.0.0.0";
}
