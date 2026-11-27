import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { GALLERY, SANDBOX, admin, call, newAgent, openSite } from "./helpers";

const db = (env as unknown as { DB: D1Database }).DB;
type ErrorBody = { error: { code: string } };
const code = async (response: Response) => ((await response.json()) as ErrorBody).error.code;
const frame = { base: SANDBOX, headers: { "Sec-Fetch-Dest": "iframe" } };

const piece = (id: string, fn: string) => ({
  id,
  title: `Piece ${id}`,
  summary: `Summary of ${id}`,
  spec: `Write ${fn}(a, b). SPEC-OF-${id}`,
  public_tests: [{ name: `${fn} example`, call: fn, args: [1, 2], expect: 3 }],
  hidden_tests: [{ name: `HIDDEN-MARKER ${fn}`, call: fn, args: [5, 5], expect: 10 }],
  reference_code: `define({ ${fn}: (a, b) => a + b }); // REFERENCE-MARKER`,
});
const CONTENT = {
  pieces: [piece("alpha", "addA"), piece("beta", "addB"), piece("gamma", "addC")],
  showcase: { title: "The test game", note: "Runs on the test engine.", code: 'canvas.getContext("2d"); // SHOWCASE-CODE' },
};
const GOOD = "define({ addA: (a, b) => a + b, addB: (a, b) => a + b, addC: (a, b) => a + b });";

interface Claim {
  work: { id: string; piece: { id: string }; status: string };
  task: string;
  examples: { name: string }[];
}
const claim = (key: string) => call("/api/v1/work/claim", { key, method: "POST" });
const handIn = (key: string, body: Record<string, unknown> = { code: GOOD }) => call("/api/v1/work/submit", { key, body });
const decide = (workId: string, action: string, passed = 2, total = 2) =>
  admin(`/api/admin/work/${workId}`, { action, tests_passed: passed, tests_total: total });
/** Lets an agent take another piece without waiting a day. */
const nextDay = (agentId: string) => db.prepare("UPDATE work SET day = id WHERE agent_id = ?").bind(agentId).run();
/** Wipes all work so a test starts from an untouched project. */
const resetWork = () =>
  db.batch([
    db.prepare("DELETE FROM work_code"),
    db.prepare("UPDATE pieces SET accepted_work_id = NULL"),
    db.prepare("DELETE FROM work"),
  ]);

async function claimed(prefix = "worker") {
  const agent = await newAgent(prefix);
  const response = await claim(agent.key);
  if (response.status !== 201) throw new Error("claim failed: " + (await response.text()));
  return { agent, claim: (await response.json()) as Claim };
}

beforeAll(async () => {
  await openSite();
});

describe("the engine project before it is switched on", () => {
  it("hands out nothing while closed, and only an admin can load content", async () => {
    const agent = await newAgent("early");
    expect(await code(await claim(agent.key))).toBe("work_closed");
    expect((await call("/api/admin/content", { body: CONTENT })).status).toBe(401);
    expect((await call("/e", frame)).status).toBe(404);
    expect(await (await call("/engine")).text()).toContain("has not started yet");
  });

  it("rejects malformed content", async () => {
    expect((await admin("/api/admin/content", { pieces: [{ ...piece("ok", "f"), id: "Bad Id" }] })).status).toBe(400);
    expect((await admin("/api/admin/content", { pieces: [{ ...piece("ok", "f"), hidden_tests: [] }] })).status).toBe(400);
    expect((await admin("/api/admin/content", { pieces: [{ ...piece("ok", "f"), public_tests: [{ name: "x" }] }] })).status).toBe(400);
    expect((await admin("/api/admin/content", {})).status).toBe(400);
  });
});

describe("taking and handing in a piece", () => {
  beforeAll(async () => {
    expect((await admin("/api/admin/content", CONTENT)).status).toBe(200);
    expect((await admin("/api/admin/settings", { work_open: true })).status).toBe(200);
  });

  it("hands an agent one piece with its task and examples, and never the hidden checks", async () => {
    const { agent, claim: first } = await claimed();
    expect(["alpha", "beta", "gamma"]).toContain(first.work.piece.id);
    expect(first.work.status).toBe("claimed");
    expect(first.task).toContain(`SPEC-OF-${first.work.piece.id}`);
    expect(first.examples).toHaveLength(1);

    // Nothing an agent or visitor can fetch carries the hidden checks or the reference code.
    const seen = [
      JSON.stringify(first),
      await (await call("/api/v1/work", { key: agent.key })).text(),
      await (await call("/api/v1/engine")).text(),
      await (await call("/engine")).text(),
      await (await call("/")).text(),
    ].join("\n");
    expect(seen).not.toContain("HIDDEN-MARKER");
    expect(seen).not.toContain("REFERENCE-MARKER");

    // One piece a day, and no choosing.
    const again = await claim(agent.key);
    expect(again.status).toBe(429);
    expect(await code(again)).toBe("daily_limit");
    expect((await call("/api/v1/work/claim", { key: agent.key, body: { piece: "alpha" } })).status).toBe(429);
  });

  it("cannot be raced into two pieces", async () => {
    const agent = await newAgent("racer");
    const results = await Promise.all(Array.from({ length: 5 }, () => claim(agent.key)));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const rows = await db.prepare("SELECT COUNT(*) AS n FROM work WHERE agent_id = ?").bind(agent.id).first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("never gives an agent the same piece twice, and runs out after it has had them all", async () => {
    const agent = await newAgent("collector");
    const got = new Set<string>();
    for (let i = 0; i < 3; i++) {
      const response = await claim(agent.key);
      expect(response.status).toBe(201);
      got.add(((await response.json()) as Claim).work.piece.id);
      await nextDay(agent.id);
    }
    expect(got.size).toBe(3);
    expect(await code(await claim(agent.key))).toBe("nothing_available");
    await db.prepare("DELETE FROM work WHERE agent_id = ?").bind(agent.id).run();
  });

  it("takes one hand-in per piece and refuses code that defines nothing", async () => {
    const { agent, claim: mine } = await claimed("submitter");
    expect(await code(await handIn(agent.key, { code: "const x = 1;" }))).toBe("invalid_code");
    expect(await code(await handIn(agent.key, { code: GOOD, model: "not a handle" }))).toBe("invalid_model");
    expect((await handIn(agent.key, { code: "x".repeat(60_001) + "define({})" })).status).toBe(413);

    const done = await handIn(agent.key, { code: GOOD, model: "test-model-1" });
    expect(done.status).toBe(201);
    expect(((await done.json()) as Claim).work.status).toBe("submitted");
    expect(await code(await handIn(agent.key))).toBe("nothing_to_hand_in");

    const stored = await db.prepare("SELECT code FROM work_code WHERE work_id = ?").bind(mine.work.id).first<{ code: string }>();
    expect(stored?.code).toBe(GOOD);
  });

  it("refuses a hand-in after the deadline or without a piece", async () => {
    const stranger = await newAgent("stranger");
    expect(await code(await handIn(stranger.key))).toBe("nothing_to_hand_in");
    const { agent, claim: mine } = await claimed("late");
    await db.prepare("UPDATE work SET expires_at = 1 WHERE id = ?").bind(mine.work.id).run();
    expect(await code(await handIn(agent.key))).toBe("expired");
    expect((await call("/api/v1/work/claim", { method: "POST" })).status).toBe(401);
  });
});

describe("checking and accepting a piece", () => {
  it("shows the checks only to the admin, inside the sandbox, with the code kept inert", async () => {
    const { agent, claim: mine } = await claimed("checked");
    const hostile = GOOD + " // </script><script>alert(1)</script>";
    await handIn(agent.key, { code: hostile });

    const overview = (await (await admin("/api/admin/overview")).json()) as {
      engine: { work: { id: string; frame_url: string; agent_name: string }[]; pieces: { id: string; status: string }[] };
    };
    const waiting = overview.engine.work.find((w) => w.id === mine.work.id)!;
    expect(waiting.agent_name).toBe(agent.name);
    const url = new URL(waiting.frame_url);
    expect(url.origin).toBe(SANDBOX);

    const page = await (await call(url.pathname + url.search, frame)).text();
    expect(page.match(/<script/g)).toHaveLength(2);
    expect(page).toContain('<script src="/piece-runner.js"></script>');
    const data = JSON.parse(/<script id="check-data" type="application\/json">(.*)<\/script>/.exec(page)![1]!) as {
      code: string;
      reportTo: string;
      tests: { name: string; hidden: boolean }[];
    };
    expect(data.code).toBe(hostile);
    expect(data.reportTo).toBe(GALLERY);
    expect(data.tests.map((t) => t.hidden)).toEqual([false, true]);

    // No signed link, a tampered one, or a direct visit gets nothing.
    expect((await call(url.pathname, frame)).status).toBe(404);
    const tampered = url.search.slice(0, -1) + (url.search.endsWith("0") ? "1" : "0");
    expect((await call(url.pathname + tampered, frame)).status).toBe(404);
    expect((await call(url.pathname + url.search, { base: SANDBOX })).status).toBe(404);
    expect((await call(url.pathname + url.search, { headers: { "Sec-Fetch-Dest": "iframe" } })).status).toBe(404);
    expect((await call("/piece-runner.js", { base: SANDBOX })).status).toBe(200);
  });

  it("accepts a piece only when every check passes, and only once", async () => {
    await resetWork();
    const first = await claimed("builder");
    const pieceId = first.claim.work.piece.id;
    await handIn(first.agent.key, { code: GOOD, model: "test-model-2" });

    expect(await code(await decide(first.claim.work.id, "accept", 1, 2))).toBe("checks_failed");
    expect(await code(await decide(first.claim.work.id, "accept", 0, 0))).toBe("checks_failed");
    expect((await decide(first.claim.work.id, "launch")).status).toBe(400);
    expect((await call(`/api/admin/work/${first.claim.work.id}`, { body: { action: "accept", tests_passed: 2, tests_total: 2 } })).status).toBe(401);
    expect((await decide(first.claim.work.id, "accept")).status).toBe(200);
    expect(await code(await decide(first.claim.work.id, "accept"))).toBe("wrong_state");

    const progress = (await (await call("/api/v1/engine")).json()) as {
      pieces_built: number;
      complete: boolean;
      pieces: { id: string; status: string; untrusted: { built_by: string; model: string } | null }[];
    };
    expect(progress.pieces_built).toBe(1);
    expect(progress.complete).toBe(false);
    const built = progress.pieces.find((p) => p.id === pieceId)!;
    expect(built.status).toBe("built");
    expect(built.untrusted).toEqual({ built_by: first.agent.name, model: "test-model-2" });
    const mine = (await (await call("/api/v1/work", { key: first.agent.key })).json()) as { work: { status: string; checks_passed: number } };
    expect(mine.work).toMatchObject({ status: "accepted", checks_passed: 2 });

    const page = await (await call("/engine")).text();
    expect(page).toContain("1 of 3 pieces built");
    expect(page).toContain(`Built by ${first.agent.name}`);
    expect(page).toContain("2 to go");
    expect(await (await call("/")).text()).toContain("1 of 3 pieces built");
  });

  it("gives built pieces to nobody and spreads agents across the rest", async () => {
    const builtRow = await db.prepare("SELECT id FROM pieces WHERE accepted_work_id IS NOT NULL").first<{ id: string }>();
    const picks: string[] = [];
    for (let i = 0; i < 4; i++) picks.push((await claimed("spread")).claim.work.piece.id);
    expect(picks).not.toContain(builtRow!.id);
    // Two open pieces and four agents: two on each.
    expect(picks.filter((id) => id === picks[0])).toHaveLength(2);
    // At most three agents on a piece at once.
    await claimed("spread");
    await claimed("spread");
    const overflow = await newAgent("overflow");
    expect(await code(await claim(overflow.key))).toBe("nothing_available");
  });

  it("starts the game only when the last piece is in", async () => {
    await db.prepare("DELETE FROM work WHERE status = 'claimed'").run();
    expect((await call("/e", frame)).status).toBe(404);
    for (let i = 0; i < 2; i++) {
      const next = await claimed("finisher");
      await handIn(next.agent.key);
      expect((await decide(next.claim.work.id, "accept")).status).toBe(200);
    }
    const progress = (await (await call("/api/v1/engine")).json()) as { complete: boolean; pieces_built: number };
    expect(progress).toMatchObject({ complete: true, pieces_built: 3 });

    const game = await call("/e", frame);
    expect(game.status).toBe(200);
    const data = JSON.parse(/<script id="build-code" type="application\/json">(.*)<\/script>/.exec(await game.text())![1]!) as {
      code: string;
      pieces: { id: string; code: string }[];
    };
    expect(data.code).toContain("SHOWCASE-CODE");
    expect(data.pieces.map((p) => p.id)).toEqual(["alpha", "beta", "gamma"]);
    expect(data.pieces.every((p) => p.code === GOOD)).toBe(true);

    const direct = await call("/e", { base: SANDBOX });
    expect(direct.status).toBe(302);
    expect(direct.headers.get("Location")).toBe(`${GALLERY}/engine`);
    const page = await (await call("/engine")).text();
    expect(page).toContain(`src="${SANDBOX}/e"`);
    expect(page).not.toContain("Send your agent");

    const latecomer = await newAgent("latecomer");
    expect(await code(await claim(latecomer.key))).toBe("nothing_available");
  });

  it("puts a piece back in the pool when its builder is banned or the admin throws it out", async () => {
    const accepted = await db
      .prepare("SELECT p.id AS piece, w.agent_id AS agent FROM pieces p JOIN work w ON w.id = p.accepted_work_id ORDER BY p.position")
      .all<{ piece: string; agent: string }>();
    const [one, two] = accepted.results;

    expect((await admin(`/api/admin/agents/${one!.agent}`, { action: "ban" })).status).toBe(200);
    expect((await admin(`/api/admin/pieces/${two!.piece}`, { action: "reopen" })).status).toBe(200);
    expect(await code(await admin(`/api/admin/pieces/${two!.piece}`, { action: "reopen" }))).toBe("wrong_state");

    const progress = (await (await call("/api/v1/engine")).json()) as { pieces_built: number; pieces: { id: string; status: string }[] };
    expect(progress.pieces_built).toBe(1);
    expect(progress.pieces.filter((p) => p.status === "open").map((p) => p.id).sort()).toEqual([one!.piece, two!.piece].sort());
    expect((await call("/e", frame)).status).toBe(404);

    // Reloading the content keeps who built what.
    expect((await admin("/api/admin/content", CONTENT)).status).toBe(200);
    expect(((await (await call("/api/v1/engine")).json()) as { pieces_built: number }).pieces_built).toBe(1);
  });
});
