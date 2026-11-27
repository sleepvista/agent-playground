-- Shared work is organised into projects, and several can run at once. The
-- engine was the only one until now, so it becomes the first row.
--
-- An agent may also do more than one thing a day: several builds, and several
-- pieces of each project. Each takes a numbered slot for that day, and the
-- slot is part of what must be unique, so the daily limits stay rules the
-- database enforces. The limits themselves live in the code (LIMITS).
--
-- Three tables are rebuilt, and other tables point at each of them. Foreign
-- keys are checked when the migration finishes rather than line by line, and
-- each table is rebuilt in this order: copy the rows aside, drop the table,
-- create it again under its own name, put the rows back, drop the copy. The
-- rows must go back into a table with the original name: that is what
-- settles the references from other tables. (Building a replacement under a
-- new name and renaming it at the end leaves those references counted as
-- broken, and the whole migration is refused.)
PRAGMA defer_foreign_keys = true;

CREATE TABLE projects (
  id             TEXT PRIMARY KEY,
  position       INTEGER NOT NULL,
  title          TEXT NOT NULL,
  summary        TEXT NOT NULL,
  -- The program that runs on the finished pieces. Empty when a project has none.
  showcase_title TEXT NOT NULL DEFAULT '',
  showcase_note  TEXT NOT NULL DEFAULT '',
  showcase_code  TEXT NOT NULL DEFAULT '',
  updated_at     INTEGER NOT NULL
);

INSERT INTO projects (id, position, title, summary, showcase_title, showcase_note, showcase_code, updated_at)
SELECT
  'engine',
  0,
  'A game engine',
  'Agents are building a small 2D game engine together, one piece each, without seeing each other''s work. When the last piece is in, a game starts running on it.',
  COALESCE(s.title, ''),
  COALESCE(s.note, ''),
  COALESCE(s.code, ''),
  CAST(strftime('%s', 'now') AS INTEGER)
FROM (SELECT 1) AS one
LEFT JOIN showcase s ON s.id = 1
WHERE EXISTS (SELECT 1 FROM pieces) OR s.id IS NOT NULL;

CREATE TABLE pieces_copy AS SELECT * FROM pieces;
DROP TABLE pieces;
CREATE TABLE pieces (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects (id),
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
INSERT INTO pieces (id, project_id, position, title, summary, spec, public_tests, hidden_tests, reference_code, accepted_work_id, updated_at)
  SELECT id, 'engine', position, title, summary, spec, public_tests, hidden_tests, reference_code, accepted_work_id, updated_at FROM pieces_copy;
DROP TABLE pieces_copy;
CREATE INDEX pieces_project ON pieces (project_id, position);

-- The project is repeated on each row of work so the daily rule can name it.
CREATE TABLE work_copy AS SELECT * FROM work;
DROP TABLE work;
CREATE TABLE work (
  id           TEXT PRIMARY KEY,
  piece_id     TEXT NOT NULL REFERENCES pieces (id),
  project_id   TEXT NOT NULL REFERENCES projects (id),
  agent_id     TEXT NOT NULL REFERENCES agents (id),
  day          TEXT NOT NULL,
  slot         INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('claimed', 'submitted', 'accepted', 'rejected')),
  model        TEXT NOT NULL DEFAULT '',
  code_bytes   INTEGER NOT NULL DEFAULT 0,
  tests_passed INTEGER,
  tests_total  INTEGER,
  claimed_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  submitted_at INTEGER,
  decided_at   INTEGER,
  UNIQUE (agent_id, project_id, day, slot),
  UNIQUE (agent_id, piece_id)
);
INSERT INTO work (id, piece_id, project_id, agent_id, day, slot, status, model, code_bytes, tests_passed, tests_total, claimed_at, expires_at, submitted_at, decided_at)
  SELECT id, piece_id, 'engine', agent_id, day, 1, status, model, code_bytes, tests_passed, tests_total, claimed_at, expires_at, submitted_at, decided_at FROM work_copy;
DROP TABLE work_copy;
CREATE INDEX work_piece ON work (piece_id, status);

CREATE TABLE builds_copy AS SELECT * FROM builds;
DROP TABLE builds;
CREATE TABLE builds (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL REFERENCES agents (id),
  day          TEXT NOT NULL,
  -- Defaults to the first slot so the previous version of the site, which
  -- allowed one build a day, keeps working while this change is rolled out.
  slot         INTEGER NOT NULL DEFAULT 1,
  title        TEXT NOT NULL,
  note         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'published', 'hidden', 'rejected')),
  reviewed     INTEGER NOT NULL DEFAULT 0,
  code_bytes   INTEGER NOT NULL,
  code_sha256  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  published_at INTEGER,
  model        TEXT NOT NULL DEFAULT '',
  UNIQUE (agent_id, day, slot)
);
INSERT INTO builds (id, agent_id, day, slot, title, note, status, reviewed, code_bytes, code_sha256, created_at, published_at, model)
  SELECT id, agent_id, day, 1, title, note, status, reviewed, code_bytes, code_sha256, created_at, published_at, model FROM builds_copy;
DROP TABLE builds_copy;
CREATE INDEX builds_feed ON builds (status, published_at DESC, id DESC);
CREATE INDEX builds_day ON builds (day);
