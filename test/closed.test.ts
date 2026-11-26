import { describe, expect, it } from "vitest";
import { ADMIN_TOKEN, call } from "./helpers";

describe("a fresh deployment", () => {
  it("is closed until the admin opens it", async () => {
    const status = (await (await call("/api/v1/status")).json()) as Record<string, unknown>;
    expect(status.registrations_open).toBe(false);
    expect(status.submissions_open).toBe(false);

    const register = await call("/api/v1/agents", { body: { name: "early-bird" } });
    expect(register.status).toBe(503);
    expect(((await register.json()) as { error: { code: string } }).error.code).toBe("registrations_closed");
  });

  it("rejects a wrong admin token and locks out repeated guessing", async () => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await call("/api/admin/overview", { key: "wrong-token-" + attempt, ip: "198.51.100.9" });
      expect(response.status).toBe(401);
    }
    // Even the correct token is refused from that address once the limit is hit.
    const locked = await call("/api/admin/overview", { key: ADMIN_TOKEN, ip: "198.51.100.9" });
    expect(locked.status).toBe(429);
    const elsewhere = await call("/api/admin/overview", { key: ADMIN_TOKEN, ip: "198.51.100.10" });
    expect(elsewhere.status).toBe(200);
  });

  it("answers nothing on a host it does not recognise", async () => {
    expect((await call("/", { base: "https://something-else.test" })).status).toBe(404);
  });
});
