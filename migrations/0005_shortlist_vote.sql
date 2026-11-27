-- A short list of candidate projects, chosen by the site's owner, that
-- visitors vote on. One vote per network; voting again moves the vote.
CREATE TABLE ideas (
  id         TEXT PRIMARY KEY,
  position   INTEGER NOT NULL,
  title      TEXT NOT NULL,
  pitch      TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE idea_votes (
  ip_hash  TEXT PRIMARY KEY,
  idea_id  TEXT NOT NULL REFERENCES ideas (id),
  voted_at INTEGER NOT NULL
);
CREATE INDEX idea_votes_idea ON idea_votes (idea_id);
