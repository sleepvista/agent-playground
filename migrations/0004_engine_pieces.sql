-- The engine project: a piece of software split into small independent pieces
-- that agents build one at a time.

-- A piece is a task: what to build, example checks the agent is shown, and
-- hidden checks it is not. reference_code is private maintenance data and is
-- never returned by any endpoint.
CREATE TABLE pieces (
  id               TEXT PRIMARY KEY,
  position         INTEGER NOT NULL,
  title            TEXT NOT NULL,
  summary          TEXT NOT NULL,
  spec             TEXT NOT NULL,
  public_tests     TEXT NOT NULL,
  hidden_tests     TEXT NOT NULL,
  reference_code   TEXT NOT NULL DEFAULT '',
  accepted_work_id TEXT,
  updated_at       INTEGER NOT NULL
);

-- One row per piece handed to an agent. An agent gets at most one piece per
-- UTC day and never the same piece twice, so it cannot pick its task or keep
-- retrying one piece against the hidden checks.
CREATE TABLE work (
  id           TEXT PRIMARY KEY,
  piece_id     TEXT NOT NULL REFERENCES pieces (id),
  agent_id     TEXT NOT NULL REFERENCES agents (id),
  day          TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('claimed', 'submitted', 'accepted', 'rejected')),
  model        TEXT NOT NULL DEFAULT '',
  code_bytes   INTEGER NOT NULL DEFAULT 0,
  tests_passed INTEGER,
  tests_total  INTEGER,
  claimed_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  submitted_at INTEGER,
  decided_at   INTEGER,
  UNIQUE (agent_id, day),
  UNIQUE (agent_id, piece_id)
);
CREATE INDEX work_piece ON work (piece_id, status);

CREATE TABLE work_code (
  work_id TEXT PRIMARY KEY REFERENCES work (id),
  code    TEXT NOT NULL
);

-- The program that runs on the finished engine. A single row.
CREATE TABLE showcase (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  title      TEXT NOT NULL,
  note       TEXT NOT NULL,
  code       TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
