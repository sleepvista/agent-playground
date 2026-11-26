import { exports } from "cloudflare:workers";

export const GALLERY = "https://gallery.test";
export const SANDBOX = "https://sandbox.test";
export const ADMIN_TOKEN = "test-admin-token-0123456789abcdef0123456789";

interface CallOptions {
  method?: string;
  body?: unknown;
  rawBody?: string;
  key?: string;
  ip?: string;
  base?: string;
  headers?: Record<string, string>;
}

const worker = (exports as unknown as { default: { fetch(request: Request): Promise<Response> } }).default;

export function call(path: string, options: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { "CF-Connecting-IP": options.ip ?? "203.0.113.1", ...options.headers };
  if (options.key) headers.Authorization = `Bearer ${options.key}`;
  let body: string | undefined;
  if (options.rawBody !== undefined) body = options.rawBody;
  else if (options.body !== undefined) body = JSON.stringify(options.body);
  if (body !== undefined && !("Content-Type" in headers)) headers["Content-Type"] = "application/json";
  return worker.fetch(
    new Request((options.base ?? GALLERY) + path, {
      method: options.method ?? (body === undefined ? "GET" : "POST"),
      headers,
      body,
      redirect: "manual",
    }),
  );
}

export const admin = (path: string, body?: unknown) => call(path, { key: ADMIN_TOKEN, body, ip: "198.51.100.200" });

export async function openSite(): Promise<void> {
  const response = await admin("/api/admin/settings", { registrations_open: true, submissions_open: true });
  if (response.status !== 200) throw new Error("could not open site: " + (await response.text()));
}

let counter = 0;
/** Registers a fresh agent from its own address and returns its key. */
export async function newAgent(prefix = "tester"): Promise<{ id: string; name: string; key: string; ip: string }> {
  counter += 1;
  const name = `${prefix}-${counter}`;
  const ip = `192.0.2.${counter}`;
  const response = await call("/api/v1/agents", { body: { name }, ip });
  if (response.status !== 201) throw new Error("register failed: " + (await response.text()));
  const data = (await response.json()) as { agent: { id: string }; api_key: string };
  return { id: data.agent.id, name, key: data.api_key, ip };
}

export const GOOD_CODE = 'const ctx = canvas.getContext("2d"); on("frame", () => ctx.fillRect(0, 0, 10, 10));';

export async function submit(key: string, overrides: Record<string, unknown> = {}): Promise<Response> {
  return call("/api/v1/builds", {
    key,
    body: { title: "A small thing", note: "Made because I liked the idea.", code: GOOD_CODE, ...overrides },
  });
}

export async function publishedBuild(prefix = "maker"): Promise<{ id: string; agent: Awaited<ReturnType<typeof newAgent>> }> {
  const agent = await newAgent(prefix);
  const response = await submit(agent.key);
  const data = (await response.json()) as { build: { id: string } };
  const approved = await admin(`/api/admin/builds/${data.build.id}`, { action: "approve" });
  if (approved.status !== 200) throw new Error("approve failed: " + (await approved.text()));
  return { id: data.build.id, agent };
}
