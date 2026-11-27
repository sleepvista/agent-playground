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
  project: { id: "engine", title: "A test engine", summary: "Agents are building a test engine together." },
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
const claimFrom = (key: string, project: string) => call("/api/v1/work/claim", { key, body: { project } });
/** Moves everything an agent took today into the past, as if a day had gone by. */
const nextDay = (agentId: string) => db.prepare("UPDATE work SET day = id WHERE agent_id = ?").bind(agentId).run();
const forget = (agentId: string) =>
  db.batch([
    db.prepare("DELETE FROM work_code WHERE work_id IN (SELECT id FROM work WHERE agent_id = ?)").bind(agentId),
    db.prepare("DELETE FROM work WHERE agent_id = ?").bind(agentId),
  ]);
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

describe("a project before it is switched on", () => {
  it("hands out nothing while closed, and only an admin can load content", async () => {
    const agent = await newAgent("early");
    expect(await code(await claim(agent.key))).toBe("work_closed");
    expect((await call("/api/admin/content", { body: CONTENT })).status).toBe(401);
    expect((await call("/p/engine", frame)).status).toBe(404);
    expect(await (await call("/projects")).text()).toContain("No project has started yet");
    expect((await call("/projects/engine")).status).toBe(404);
    expect((await call("/api/v1/projects/engine")).status).toBe(404);
    expect(((await (await call("/api/v1/projects")).json()) as { projects: unknown[] }).projects).toEqual([]);
    // The first project's old address still leads to it.
    const old = await call("/engine");
    expect(old.status).toBe(301);
    expect(old.headers.get("Location")).toBe("/projects/engine");
  });

  it("rejects malformed content", async () => {
    const { project } = CONTENT;
    const load = (body: unknown) => admin("/api/admin/content", body);
    expect((await load({ project, pieces: [{ ...piece("ok", "f"), id: "Bad Id" }] })).status).toBe(400);
    expect((await load({ project, pieces: [{ ...piece("ok", "f"), hidden_tests: [] }] })).status).toBe(400);
    expect((await load({ project, pieces: [{ ...piece("ok", "f"), public_tests: [{ name: "x" }] }] })).status).toBe(400);
    expect((await load({ project, pieces: [piece("ok", "f"), piece("ok", "g")] })).status).toBe(400);
    expect((await load({ project, pieces: [] })).status).toBe(400);
    expect((await load({ project: { ...project, id: "Bad Id" }, pieces: [piece("ok", "f")] })).status).toBe(400);
    expect((await load({ project: { ...project, summary: "" }, pieces: [piece("ok", "f")] })).status).toBe(400);
    expect((await load({ pieces: [piece("ok", "f")] })).status).toBe(400);
    expect((await load({})).status).toBe(400);
    expect(((await (await call("/api/v1/projects")).json()) as { projects: unknown[] }).projects).toEqual([]);
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
      await (await call("/api/v1/projects")).text(),
      await (await call("/api/v1/projects/engine")).text(),
      await (await call("/projects/engine")).text(),
      await (await call("/projects")).text(),
      await (await call("/")).text(),
    ].join("\n");
    expect(seen).not.toContain("HIDDEN-MARKER");
    expect(seen).not.toContain("REFERENCE-MARKER");

    // One piece in hand at a time, and no choosing.
    const again = await claim(agent.key);
    expect(again.status).toBe(409);
    expect(await code(again)).toBe("piece_in_hand");
    expect(await code(await call("/api/v1/work/claim", { key: agent.key, body: { piece: "alpha" } }))).toBe("piece_in_hand");
  });

  it("tells a returning agent in one place what is still open to it today", async () => {
    type Me = {
      today: { can_build: boolean; piece_to_hand_in: boolean; can_take_a_piece: boolean; can_answer_a_problem: boolean; checking_to_hand_in: boolean; can_take_checking: boolean };
    };
    // The problems and checking work are switched off throughout this file.
    const today = async (key: string) => {
      const { can_answer_a_problem: problems, checking_to_hand_in: holding, can_take_checking: checking, ...rest } = ((await (await call("/api/v1/me", { key })).json()) as Me).today;
      expect([problems, holding, checking]).toEqual([false, false, false]);
      return rest;
    };
    const agent = await newAgent("returning");
    expect(await today(agent.key)).toEqual({ can_build: true, piece_to_hand_in: false, can_take_a_piece: true });

    await claim(agent.key);
    expect(await today(agent.key)).toEqual({ can_build: true, piece_to_hand_in: true, can_take_a_piece: false });
    // Once the piece is handed in the agent may take another the same day.
    await handIn(agent.key);
    expect(await today(agent.key)).toEqual({ can_build: true, piece_to_hand_in: false, can_take_a_piece: true });
    for (const title of ["First of the day", "Second of the day", "Third of the day"]) {
      expect((await call("/api/v1/builds", { key: agent.key, body: { title, note: "", code: 'canvas.getContext("2d");' } })).status).toBe(201);
    }
    expect(await today(agent.key)).toEqual({ can_build: false, piece_to_hand_in: false, can_take_a_piece: true });

    // A piece somebody else finished first is no longer something to hand in, and does not block taking another.
    const held = (await (await claim(agent.key)).json()) as Claim;
    await db.prepare("UPDATE pieces SET accepted_work_id = 'w_someone_else' WHERE id = ?").bind(held.work.piece.id).run();
    expect(await today(agent.key)).toEqual({ can_build: false, piece_to_hand_in: false, can_take_a_piece: true });
    expect(await code(await handIn(agent.key))).toBe("piece_done");
    expect((await claim(agent.key)).status).toBe(201);
    await db.prepare("UPDATE pieces SET accepted_work_id = NULL WHERE id = ?").bind(held.work.piece.id).run();

    // Nothing is open while the switches are off.
    await admin("/api/admin/settings", { work_open: false, submissions_open: false });
    const other = await newAgent("shut-out");
    expect(await today(other.key)).toEqual({ can_build: false, piece_to_hand_in: false, can_take_a_piece: false });
    await admin("/api/admin/settings", { work_open: true, submissions_open: true });
    await forget(agent.id);
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
      expect((await handIn(agent.key)).status).toBe(201);
    }
    expect(got.size).toBe(3);
    expect(await code(await claim(agent.key))).toBe("nothing_available");
    await nextDay(agent.id);
    expect(await code(await claim(agent.key))).toBe("nothing_available");
    await forget(agent.id);
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
      work: {
        waiting: { id: string; frame_url: string; agent_name: string; project_title: string }[];
        projects: { id: string; pieces: { id: string; status: string }[] }[];
      };
    };
    const waiting = overview.work.waiting.find((w) => w.id === mine.work.id)!;
    expect(waiting.agent_name).toBe(agent.name);
    expect(waiting.project_title).toBe("A test engine");
    expect(overview.work.projects.map((project) => [project.id, project.pieces.length])).toEqual([["engine", 3]]);
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

    const progress = (await (await call("/api/v1/projects/engine")).json()) as {
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

    const page = await (await call("/projects/engine")).text();
    expect(page).toContain("A test engine, built one piece at a time");
    expect(page).toContain("1 of 3 pieces built");
    expect(page).toContain(`Built by ${first.agent.name}`);
    expect(page).toContain("2 to go");
    expect(await (await call("/")).text()).toContain("1 of 3 pieces built");
    expect(await (await call("/projects")).text()).toContain("1 of 3 pieces built");
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
    expect((await call("/p/engine", frame)).status).toBe(404);
    for (let i = 0; i < 2; i++) {
      const next = await claimed("finisher");
      await handIn(next.agent.key);
      expect((await decide(next.claim.work.id, "accept")).status).toBe(200);
    }
    const progress = (await (await call("/api/v1/projects/engine")).json()) as { complete: boolean; pieces_built: number };
    expect(progress).toMatchObject({ complete: true, pieces_built: 3 });

    const game = await call("/p/engine", frame);
    expect(game.status).toBe(200);
    const data = JSON.parse(/<script id="build-code" type="application\/json">(.*)<\/script>/.exec(await game.text())![1]!) as {
      code: string;
      pieces: { id: string; code: string }[];
    };
    expect(data.code).toContain("SHOWCASE-CODE");
    expect(data.pieces.map((p) => p.id)).toEqual(["alpha", "beta", "gamma"]);
    expect(data.pieces.every((p) => p.code === GOOD)).toBe(true);

    const direct = await call("/p/engine", { base: SANDBOX });
    expect(direct.status).toBe(302);
    expect(direct.headers.get("Location")).toBe(`${GALLERY}/projects/engine`);
    const page = await (await call("/projects/engine")).text();
    expect(page).toContain(`src="${SANDBOX}/p/engine"`);
    expect(page).not.toContain("take a piece of the project");
    expect(await (await call("/")).text()).toContain("See it running");

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

    const progress = (await (await call("/api/v1/projects/engine")).json()) as { pieces_built: number; pieces: { id: string; status: string }[] };
    expect(progress.pieces_built).toBe(1);
    expect(progress.pieces.filter((p) => p.status === "open").map((p) => p.id).sort()).toEqual([one!.piece, two!.piece].sort());
    expect((await call("/p/engine", frame)).status).toBe(404);

    // Reloading the content keeps who built what.
    expect((await admin("/api/admin/content", CONTENT)).status).toBe(200);
    expect(((await (await call("/api/v1/projects/engine")).json()) as { pieces_built: number }).pieces_built).toBe(1);
  });
});

describe("several projects at once", () => {
  const second = (id: string, fn: string) => ({ ...piece(id, fn), reference_code: `define({ ${fn}: (a, b) => a + b });` });
  const ATLAS = {
    project: { id: "atlas", title: "A test atlas", summary: "A second project, running beside the first." },
    pieces: [second("delta", "addD"), second("epsilon", "addE"), second("zeta", "addF"), second("eta", "addG")],
  };
  const ATLAS_CODE = "define({ addD: (a, b) => a + b, addE: (a, b) => a + b, addF: (a, b) => a + b, addG: (a, b) => a + b });";
  type Projects = { projects: { id: string; pieces_total: number; pieces_built: number; complete: boolean }[] };

  beforeAll(async () => {
    await db.prepare("DELETE FROM work WHERE status = 'claimed'").run();
    expect((await admin("/api/admin/content", ATLAS)).status).toBe(200);
  });

  it("lists every project and shows each on its own page", async () => {
    const list = (await (await call("/api/v1/projects")).json()) as Projects;
    expect(list.projects.map((project) => [project.id, project.pieces_total, project.pieces_built])).toEqual([
      ["engine", 3, 1],
      ["atlas", 4, 0],
    ]);
    for (const path of ["/", "/projects"]) {
      const page = await (await call(path)).text();
      expect(page).toContain("A test engine");
      expect(page).toContain("A test atlas");
      expect(page).toContain("0 of 4 pieces built");
    }
    // A project without a program to run on it simply has no such section.
    const page = await (await call("/projects/atlas")).text();
    expect(page).toContain("A test atlas, built one piece at a time");
    expect(page).not.toContain("cannot start yet");
    expect(page).toContain("take a piece of the project &quot;atlas&quot;");
    expect((await call("/projects/nowhere")).status).toBe(404);
  });

  it("keeps each project's pieces its own", async () => {
    const thief = { project: { id: "thief", title: "A thief", summary: "Tries to take a piece." }, pieces: [piece("alpha", "addA")] };
    expect(await code(await admin("/api/admin/content", thief))).toBe("piece_id_taken");
    const list = (await (await call("/api/v1/projects")).json()) as Projects;
    expect(list.projects.map((project) => project.id)).toEqual(["engine", "atlas"]);
  });

  it("lets an agent name a project but never a piece", async () => {
    const agent = await newAgent("chooser");
    expect((await claimFrom(agent.key, "nowhere")).status).toBe(404);
    expect(await code(await claimFrom(agent.key, "Not An Id"))).toBe("invalid_project");
    const response = await claimFrom(agent.key, "atlas");
    expect(response.status).toBe(201);
    const taken = (await response.json()) as Claim & { work: { project: { id: string; title: string } } };
    expect(taken.work.project).toEqual({ id: "atlas", title: "A test atlas" });
    expect(["delta", "epsilon", "zeta", "eta"]).toContain(taken.work.piece.id);
    await forget(agent.id);
  });

  it("allows three pieces a day in each project, counted separately", async () => {
    const agent = await newAgent("busy");
    type Standing = { can_take_a_piece_now: boolean; projects: { id: string; pieces_left_today: number; has_a_piece_for_you: boolean }[] };
    const standing = async () => (await (await call("/api/v1/work", { key: agent.key })).json()) as Standing;
    expect((await standing()).projects).toEqual([
      { id: "engine", title: "A test engine", pieces_left_today: 3, has_a_piece_for_you: true },
      { id: "atlas", title: "A test atlas", pieces_left_today: 3, has_a_piece_for_you: true },
    ]);

    for (let i = 0; i < 3; i++) {
      expect((await claimFrom(agent.key, "atlas")).status).toBe(201);
      expect((await handIn(agent.key, { code: ATLAS_CODE })).status).toBe(201);
    }
    // The fourth piece of the same project has to wait for tomorrow, though one is still open.
    const fourth = await claimFrom(agent.key, "atlas");
    expect(fourth.status).toBe(429);
    expect(await code(fourth)).toBe("daily_limit");
    expect(Number((await claimFrom(agent.key, "atlas")).headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(await standing()).toMatchObject({
      can_take_a_piece_now: true,
      projects: [
        { id: "engine", pieces_left_today: 3, has_a_piece_for_you: true },
        { id: "atlas", pieces_left_today: 0, has_a_piece_for_you: true },
      ],
    });

    // The other project is untouched by that, and a claim that names no project finds it.
    const elsewhere = await claim(agent.key);
    expect(elsewhere.status).toBe(201);
    expect(((await elsewhere.json()) as { work: { project: { id: string } } }).work.project.id).toBe("engine");
    expect((await handIn(agent.key)).status).toBe(201);

    // The limit is the database's own rule: each piece of the day takes a numbered slot in its project.
    const slots = await db
      .prepare("SELECT project_id, slot FROM work WHERE agent_id = ? ORDER BY project_id, slot")
      .bind(agent.id)
      .all<{ project_id: string; slot: number }>();
    expect(slots.results.map((row) => `${row.project_id}:${row.slot}`)).toEqual(["atlas:1", "atlas:2", "atlas:3", "engine:1"]);
    await expect(
      db.prepare("UPDATE work SET slot = 1 WHERE agent_id = ? AND project_id = 'atlas' AND slot = 2").bind(agent.id).run(),
    ).rejects.toThrow(/UNIQUE/);

    // A day later the last piece of the first project is there to take.
    await nextDay(agent.id);
    expect((await claimFrom(agent.key, "atlas")).status).toBe(201);
    await forget(agent.id);
  });

  it("cannot be raced past the daily limit", async () => {
    const agent = await newAgent("sprinter");
    for (let i = 0; i < 2; i++) {
      expect((await claimFrom(agent.key, "atlas")).status).toBe(201);
      expect((await handIn(agent.key, { code: ATLAS_CODE })).status).toBe(201);
    }
    const results = await Promise.all(Array.from({ length: 5 }, () => claimFrom(agent.key, "atlas")));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const rows = await db.prepare("SELECT COUNT(*) AS n FROM work WHERE agent_id = ?").bind(agent.id).first<{ n: number }>();
    expect(rows?.n).toBe(3);
    await forget(agent.id);
  });

  it("finishes one project without touching the other", async () => {
    await db.prepare("DELETE FROM work WHERE status = 'claimed'").run();
    for (let i = 0; i < 2; i++) {
      const agent = await newAgent("closer");
      const taken = (await (await claimFrom(agent.key, "engine")).json()) as Claim;
      await handIn(agent.key);
      expect((await decide(taken.work.id, "accept")).status).toBe(200);
    }
    const list = (await (await call("/api/v1/projects")).json()) as Projects;
    expect(list.projects.map((project) => [project.id, project.complete])).toEqual([
      ["engine", true],
      ["atlas", false],
    ]);
    expect((await call("/p/engine", frame)).status).toBe(200);
    expect((await call("/p/atlas", frame)).status).toBe(404);

    // A finished project hands out nothing; the unfinished one still does.
    const agent = await newAgent("after");
    expect(await code(await claimFrom(agent.key, "engine"))).toBe("nothing_available");
    expect((await claim(agent.key)).status).toBe(201);
  });
});
