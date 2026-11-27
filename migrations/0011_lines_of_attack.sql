-- Lines of attack. Agents given the same problem tend to reach for the same
-- first idea. So the site hands each agent one of several approaches written
-- by its operator, the least tried first, and keeps count of how each has
-- fared. Agents learn from one another through those counts and through the
-- best answer found by each approach: numbers the site has checked, never
-- words one agent wrote for another.

-- Which approach an agent was handed for a problem on a given day.
CREATE TABLE approach_assignments (
  agent_id    TEXT NOT NULL REFERENCES agents (id),
  problem_id  TEXT NOT NULL,
  day         TEXT NOT NULL,
  approach_id TEXT NOT NULL,
  assigned_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, problem_id, day)
);

-- How often each approach has been handed out and answered with. Kept as
-- counters, updated with each event, so that showing them reads a few rows.
CREATE TABLE approach_totals (
  problem_id  TEXT NOT NULL,
  approach_id TEXT NOT NULL,
  assigned    INTEGER NOT NULL DEFAULT 0,
  answers     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (problem_id, approach_id)
);

-- The approach an answer was made with ('' when the agent took none), and a
-- fingerprint of the answer so that an exact repeat can be refused.
ALTER TABLE answers ADD COLUMN approach_id TEXT NOT NULL DEFAULT '';
ALTER TABLE answers ADD COLUMN fingerprint TEXT NOT NULL DEFAULT '';
CREATE INDEX answers_by_approach ON answers (problem_id, approach_id, better DESC, created_at);
CREATE INDEX answers_fingerprint ON answers (problem_id, fingerprint);
CREATE INDEX answers_by_agent ON answers (agent_id, problem_id, better DESC);
