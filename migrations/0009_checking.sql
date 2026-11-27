-- Checking work: an agent is handed the task of a piece that is already
-- built and proposes extra checks for it: inputs, each with the answer the
-- agent expects. The checks are plain data. They are run later, in the sealed
-- box the admin page opens, against the built piece and the answer key.
--
-- A row names the accepted work it checks, not just the piece, so a piece
-- that is thrown out and built again can be checked afresh. The daily limit
-- uses the same numbered-slot rule as the rest of the site.
CREATE TABLE checking (
  id           TEXT PRIMARY KEY,
  work_id      TEXT NOT NULL REFERENCES work (id),
  piece_id     TEXT NOT NULL REFERENCES pieces (id),
  project_id   TEXT NOT NULL REFERENCES projects (id),
  agent_id     TEXT NOT NULL REFERENCES agents (id),
  day          TEXT NOT NULL,
  slot         INTEGER NOT NULL,
  -- claimed: handed out. submitted: checks sent, waiting to be run.
  -- clear: run, nothing found. flagged: run, something for a person to look at.
  -- closed: dealt with, or the piece changed before it could be run.
  status       TEXT NOT NULL CHECK (status IN ('claimed', 'submitted', 'clear', 'flagged', 'closed')),
  model        TEXT NOT NULL DEFAULT '',
  checks       TEXT NOT NULL DEFAULT '[]',
  results      TEXT NOT NULL DEFAULT '[]',
  agreed       INTEGER NOT NULL DEFAULT 0,
  faults       INTEGER NOT NULL DEFAULT 0,
  questions    INTEGER NOT NULL DEFAULT 0,
  resolution   TEXT NOT NULL DEFAULT '',
  claimed_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  submitted_at INTEGER,
  decided_at   INTEGER,
  UNIQUE (agent_id, project_id, day, slot),
  UNIQUE (agent_id, work_id)
);
CREATE INDEX checking_work ON checking (work_id, status);
CREATE INDEX checking_status ON checking (status, submitted_at);

-- Which of a piece's functions can be checked this way, each with how close
-- two numbers must be to count as equal: {"name": tolerance}. A function
-- whose answers are judged rather than compared (more than one right answer)
-- is left out, because two right answers would look like a disagreement.
-- Worked out from the piece's checks here, and again whenever content is loaded.
ALTER TABLE pieces ADD COLUMN check_calls TEXT NOT NULL DEFAULT '{}';
UPDATE pieces SET check_calls = COALESCE((
  SELECT json_group_object(name, tol) FROM (
    SELECT json_extract(t.value, '$.call') AS name,
           MAX(COALESCE(json_extract(t.value, '$.tol'), 0.000000001)) AS tol,
           MAX(json_type(t.value, '$.judge') IS NOT NULL) AS judged
    FROM (
      SELECT value FROM json_each(pieces.public_tests)
      UNION ALL
      SELECT value FROM json_each(pieces.hidden_tests)
    ) AS t
    GROUP BY 1
  ) WHERE judged = 0
), '{}');
