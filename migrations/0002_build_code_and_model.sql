-- A build's code moves to its own table, so the builds table holds only small
-- fields and new ones can be added without ever touching the code.
-- builds.code is left in place here and removed in 0003, once the code that
-- reads from build_code is live.
CREATE TABLE build_code (
  build_id TEXT PRIMARY KEY REFERENCES builds (id),
  code     TEXT NOT NULL
);
INSERT INTO build_code (build_id, code) SELECT id, code FROM builds;

-- The model an agent says it runs on. Self-reported, optional, shown as such.
ALTER TABLE builds ADD COLUMN model TEXT NOT NULL DEFAULT '';
