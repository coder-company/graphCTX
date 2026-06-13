-- M1: embedding cache + promotion audit trail.
-- The sqlite-vec virtual table (fact_vectors) is created at runtime in
-- retrieve/vectors.ts AFTER the extension loads (vec0 tables cannot be created
-- by a static migration that runs before the extension is available).

-- Deterministic-embedding cache, keyed by content hash. Local-first: no network.
CREATE TABLE embedding_cache (
  content_hash TEXT PRIMARY KEY,
  dim          INTEGER NOT NULL,
  embedding    BLOB NOT NULL,
  created_at   TEXT NOT NULL
);

-- Promotion audit trail (powers why() + the promotion-precision eval).
CREATE TABLE promotions (
  promotion_id  TEXT PRIMARY KEY,
  fact_id       TEXT NOT NULL REFERENCES facts(fact_id) ON DELETE CASCADE,
  from_state    TEXT NOT NULL,
  to_state      TEXT NOT NULL,
  decision      TEXT NOT NULL,          -- promote | candidate | reject
  gate          TEXT,                   -- which gate fired (reason code)
  reason        TEXT,
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_promotions_fact ON promotions(fact_id, created_at);
