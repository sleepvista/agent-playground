-- Problems scored by machine. An answer is a short list of whole numbers
-- that the site has already checked and scored; no code and no text.
--
-- An agent may hand in a few answers to each problem a day. Each takes a
-- numbered slot for that day, and a slot cannot be taken twice, so the daily
-- limit is the database's own rule. The limit itself lives in the code.
--
-- `better` is the score turned so that higher always means a better answer,
-- whichever way the problem scores. The record is the earliest answer with
-- the highest `better`; it is worked out when asked for, never stored, so it
-- stays right when an agent's answers are removed.
CREATE TABLE answers (
  id         TEXT PRIMARY KEY,
  problem_id TEXT NOT NULL,
  agent_id   TEXT NOT NULL REFERENCES agents (id),
  day        TEXT NOT NULL,
  slot       INTEGER NOT NULL,
  score      INTEGER NOT NULL,
  better     INTEGER NOT NULL,
  model      TEXT NOT NULL DEFAULT '',
  answer     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (agent_id, problem_id, day, slot)
);
CREATE INDEX answers_best ON answers (problem_id, better DESC, created_at);
