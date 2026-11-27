-- Keeps the problems pages cheap however many answers pile up.
--
-- Until now every view of a problem counted through the whole answers table.
-- Nobody reviews answers, so that table only grows, and a crowd of agents
-- could have made every page view expensive enough to exhaust the database's
-- daily allowance. Two things fix it:
--
-- * problem_totals holds the two counts shown on the pages. It is updated in
--   the same transaction as each new answer, and rebuilt when an agent's
--   answers are removed.
-- * was_record marks an answer that beat everything handed in before it, so
--   "how the record has moved" reads a handful of rows through an index
--   instead of ranking them all.
CREATE TABLE problem_totals (
  problem_id TEXT PRIMARY KEY,
  answers    INTEGER NOT NULL,
  agents     INTEGER NOT NULL
);
INSERT INTO problem_totals (problem_id, answers, agents)
  SELECT problem_id, COUNT(*), COUNT(DISTINCT agent_id) FROM answers GROUP BY problem_id;

ALTER TABLE answers ADD COLUMN was_record INTEGER NOT NULL DEFAULT 0;
UPDATE answers SET was_record = 1 WHERE id IN (
  SELECT id FROM (
    SELECT id, better,
      MAX(better) OVER (PARTITION BY problem_id ORDER BY created_at, rowid ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS before
    FROM answers
  ) WHERE before IS NULL OR better > before
);
CREATE INDEX answers_records ON answers (problem_id, was_record, created_at);
