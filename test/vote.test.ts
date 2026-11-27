import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { GALLERY, admin, call } from "./helpers";

const db = (env as unknown as { DB: D1Database }).DB;
type ErrorBody = { error: { code: string } };
const code = async (response: Response) => ((await response.json()) as ErrorBody).error.code;
interface Idea {
  id: string;
  title: string;
  votes: number;
}
const vote = (idea: string, ip: string, headers: Record<string, string> = {}) => call("/api/v1/vote", { body: { idea }, ip, headers });
const counts = async () => {
  const overview = (await (await admin("/api/admin/overview")).json()) as { vote: { ideas: Idea[]; total: number } };
  return Object.fromEntries(overview.vote.ideas.map((idea) => [idea.title, idea.votes]));
};

let chess: string;
let world: string;

describe("the shortlist vote", () => {
  beforeAll(async () => {
    const add = async (title: string, pitch: string) =>
      ((await (await admin("/api/admin/ideas", { title, pitch })).json()) as { idea: Idea }).idea.id;
    chess = await add("A chess engine", "Legal moves, a way to judge a position, and a search that picks a move.");
    world = await add("A world generator", "Terrain, rivers and towns grown from a single number, as a map to explore.");
  });

  it("is closed until the admin opens it, and only the admin edits the shortlist", async () => {
    expect(await code(await vote(chess, "203.0.113.1"))).toBe("vote_closed");
    const closed = await (await call("/vote")).text();
    expect(closed).toContain("Voting is closed");
    expect(closed).not.toContain("vote-button");
    expect((await call("/api/admin/ideas", { body: { title: "Sneaky idea", pitch: "Added by a stranger." } })).status).toBe(401);
    expect(await code(await admin("/api/admin/ideas", { title: "Has a link", pitch: "See www.example.org for details." }))).toBe("invalid_pitch");
    expect(await code(await admin("/api/admin/ideas", { title: "x", pitch: "Too short a title." }))).toBe("invalid_title");
    expect((await admin("/api/admin/settings", { vote_open: true })).status).toBe(200);
  });

  it("counts one vote per network and lets it move", async () => {
    expect((await vote(chess, "203.0.113.1")).status).toBe(200);
    expect((await vote(chess, "203.0.113.1")).status).toBe(200);
    expect(await counts()).toEqual({ "A chess engine": 1, "A world generator": 0 });

    expect((await vote(world, "203.0.113.2")).status).toBe(200);
    expect((await vote(world, "203.0.113.3")).status).toBe(200);
    // The whole of one home IPv6 network counts as one voter.
    expect((await vote(world, "2001:db8:1:2::aaaa")).status).toBe(200);
    expect((await vote(world, "2001:db8:1:2::bbbb")).status).toBe(200);
    expect(await counts()).toEqual({ "A chess engine": 1, "A world generator": 3 });

    // Moving a vote takes it from one and gives it to the other.
    expect((await vote(world, "203.0.113.1")).status).toBe(200);
    expect(await counts()).toEqual({ "A chess engine": 0, "A world generator": 4 });
    const rows = await db.prepare("SELECT COUNT(*) AS n FROM idea_votes").first<{ n: number }>();
    expect(rows?.n).toBe(4);
    // Addresses are stored only as keyed hashes.
    const stored = JSON.stringify((await db.prepare("SELECT * FROM idea_votes").all()).results);
    expect(stored).not.toContain("203.0.113");
  });

  it("shows each visitor their own vote and the running totals", async () => {
    const mine = await (await call("/vote", { ip: "203.0.113.2" })).text();
    expect(mine).toContain("Voting is open");
    expect(mine).toContain("4 votes so far");
    expect(mine).toContain('<span class="chosen">Your vote</span>');
    expect(mine).toContain(`data-idea="${chess}">Move my vote here`);
    const fresh = await (await call("/vote", { ip: "203.0.113.99" })).text();
    expect(fresh).not.toContain("Your vote</span>");
    expect(fresh.match(/Vote for this/g)).toHaveLength(2);
    expect(await (await call("/")).text()).toContain("What should agents build next?");
    // Agents are not asked to vote.
    expect(await (await call("/skill.md")).text()).not.toContain("/vote");
  });

  it("refuses votes for things that are not candidates, from other websites, or in bulk", async () => {
    expect(await code(await vote("i_0000000000000000", "203.0.113.5"))).toBe("not_found");
    expect(await code(await vote("anything", "203.0.113.5"))).toBe("invalid_idea");
    expect((await vote(chess, "203.0.113.5", { Origin: "https://evil.example" })).status).toBe(403);
    expect((await vote(chess, "203.0.113.5", { Origin: GALLERY })).status).toBe(200);
    const flip = [world, chess];
    let last = 200;
    for (let i = 0; i < 12; i++) last = (await vote(flip[i % 2]!, "203.0.113.6")).status;
    expect(last).toBe(429);
  });

  it("lets the admin remove a candidate with its votes, clear the count, and close the vote", async () => {
    expect((await admin(`/api/admin/ideas/${world}`, { action: "remove" })).status).toBe(200);
    expect((await admin(`/api/admin/ideas/${world}`, { action: "remove" })).status).toBe(404);
    const after = await counts();
    expect(Object.keys(after)).toEqual(["A chess engine"]);
    expect(after["A chess engine"]).toBeGreaterThan(0);
    const orphans = await db.prepare("SELECT COUNT(*) AS n FROM idea_votes WHERE idea_id NOT IN (SELECT id FROM ideas)").first<{ n: number }>();
    expect(orphans?.n).toBe(0);

    expect((await admin("/api/admin/votes", { action: "clear" })).status).toBe(200);
    expect(await counts()).toEqual({ "A chess engine": 0 });
    expect((await call("/api/admin/votes", { body: { action: "clear" } })).status).toBe(401);

    await admin("/api/admin/settings", { vote_open: false });
    expect(await code(await vote(chess, "203.0.113.7"))).toBe("vote_closed");
    expect(await (await call("/")).text()).not.toContain("What should agents build next?");
  });

  it("escapes candidate text and caps the size of the shortlist", async () => {
    const tricky = 'A <b>bold</b> "idea" & more';
    // Markup is refused when a candidate is added. The page must still be safe if some ever got in, so it is planted directly.
    expect((await admin("/api/admin/ideas", { title: tricky, pitch: "Text with tags that must stay text." })).status).toBe(400);
    await db.prepare("INSERT INTO ideas (id, position, title, pitch, created_at) VALUES ('i_planted', 99, ?, 'Text with <tags> that must stay text.', 1)").bind(tricky).run();
    const page = await (await call("/vote")).text();
    expect(page).toContain("A &lt;b&gt;bold&lt;/b&gt; &quot;idea&quot; &amp; more");
    expect(page).not.toContain("<b>bold</b>");
    for (let i = 0; i < 6; i++) await admin("/api/admin/ideas", { title: `Filler idea ${i}`, pitch: "Only here to fill the shortlist." });
    expect(await code(await admin("/api/admin/ideas", { title: "One too many", pitch: "The shortlist is already full." }))).toBe("shortlist_full");
  });
});
