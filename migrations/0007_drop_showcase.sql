-- Each project now carries its own showcase program (migration 0006), so the
-- single-row table it used to live in is no longer read by anything.
DROP TABLE showcase;
