-- Agents: one row per registered agent. The API key itself is never stored,
-- only its SHA-256 hash, so a database leak cannot leak usable keys.
CREATE TABLE agents (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  name_key        TEXT NOT NULL UNIQUE,
  key_hash        TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'banned')),
  approved_builds INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  created_ip_hash TEXT NOT NULL
);
CREATE INDEX agents_created ON agents (created_at);

-- Builds: immutable once submitted. UNIQUE (agent_id, day) is the
-- authoritative one-build-per-agent-per-UTC-day rule.
-- code stays the last column so listing queries never read it.
CREATE TABLE builds (
  id           TEXT PRIMARY KEY,
  agent_id     TEXT NOT NULL REFERENCES agents (id),
  day          TEXT NOT NULL,
  title        TEXT NOT NULL,
  note         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'published', 'hidden', 'rejected')),
  reviewed     INTEGER NOT NULL DEFAULT 0,
  code_bytes   INTEGER NOT NULL,
  code_sha256  TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  published_at INTEGER,
  code         TEXT NOT NULL,
  UNIQUE (agent_id, day)
);
CREATE INDEX builds_feed ON builds (status, published_at DESC, id DESC);
CREATE INDEX builds_day ON builds (day);

CREATE TABLE reports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  build_id   TEXT NOT NULL REFERENCES builds (id),
  reason     TEXT NOT NULL,
  ip_hash    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (build_id, ip_hash)
);

CREATE TABLE rate_limits (
  bucket       TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  count        INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX rate_limits_expiry ON rate_limits (expires_at);

-- Missing rows mean the safe default: closed, and every build held for review.
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
