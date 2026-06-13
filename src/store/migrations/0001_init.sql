CREATE TABLE facts (
  fact_id            TEXT PRIMARY KEY,
  subject_id         TEXT NOT NULL,
  predicate          TEXT NOT NULL,
  object_json        TEXT NOT NULL,
  fact_kind          TEXT NOT NULL,
  temporal_kind      TEXT NOT NULL,
  scope_user_id      TEXT NOT NULL,
  scope_workspace_id TEXT,
  scope_session_id   TEXT,
  status             TEXT NOT NULL,
  promotion_state    TEXT NOT NULL,
  trust_tier         TEXT NOT NULL,
  sensitivity        TEXT NOT NULL,
  confidence         REAL NOT NULL DEFAULT 0.5,
  evidence_count     INTEGER NOT NULL DEFAULT 1,
  contradiction_count INTEGER NOT NULL DEFAULT 0,
  injection_count    INTEGER NOT NULL DEFAULT 0,
  last_verified_at   TEXT,
  last_injected_at   TEXT,
  t_created          TEXT NOT NULL,
  t_recorded         TEXT NOT NULL,
  t_expired          TEXT,
  invalidated_by     TEXT REFERENCES facts(fact_id),
  asserted_by        TEXT NOT NULL,
  source_event_ids_json TEXT NOT NULL DEFAULT '[]',
  source_commit      TEXT,
  raw_quote          TEXT,
  tags_json          TEXT NOT NULL DEFAULT '[]',
  graph_version      INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE git_anchors (
  fact_id              TEXT PRIMARY KEY REFERENCES facts(fact_id) ON DELETE CASCADE,
  repo_id              TEXT,
  branch               TEXT,
  base_head            TEXT,
  introduced_by_commit TEXT,
  valid_from_commit    TEXT,
  valid_until_commit   TEXT,
  invalidated_by_commit TEXT,
  path_globs_json      TEXT,
  file_ids_json        TEXT,
  symbol_ids_json      TEXT,
  hunk_fingerprints_json TEXT,
  patch_id             TEXT
);

CREATE TABLE entities (
  entity_id          TEXT PRIMARY KEY,
  kind               TEXT NOT NULL,
  canonical_name     TEXT NOT NULL,
  aliases_json       TEXT NOT NULL DEFAULT '[]',
  scope_user_id      TEXT NOT NULL,
  scope_workspace_id TEXT
);

CREATE TABLE edges (
  edge_id        TEXT PRIMARY KEY,
  from_id        TEXT NOT NULL,
  edge_kind      TEXT NOT NULL,
  to_id          TEXT NOT NULL,
  scope_json     TEXT,
  source_fact_id TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE episodes (
  event_id     TEXT PRIMARY KEY,
  session_id   TEXT NOT NULL,
  workspace_id TEXT,
  event_type   TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  git_head     TEXT,
  git_branch   TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE procedures (
  procedure_id   TEXT PRIMARY KEY,
  fact_id        TEXT NOT NULL REFERENCES facts(fact_id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  procedure_json TEXT NOT NULL,
  success_count  INTEGER NOT NULL DEFAULT 0,
  failure_count  INTEGER NOT NULL DEFAULT 0,
  last_success_commit TEXT,
  last_success_at TEXT
);

CREATE TABLE injections (
  injection_id      TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  selected_fact_ids_json TEXT NOT NULL,
  rejected_fact_ids_json TEXT,
  token_count       INTEGER NOT NULL,
  predicted_utility REAL,
  git_head          TEXT,
  outcome_json      TEXT,
  created_at        TEXT NOT NULL
);

CREATE VIRTUAL TABLE facts_fts USING fts5(
  fact_id UNINDEXED, text, tags
);

CREATE INDEX idx_facts_scope   ON facts(scope_user_id, scope_workspace_id, scope_session_id);
CREATE INDEX idx_facts_sp      ON facts(subject_id, predicate);
CREATE INDEX idx_facts_status  ON facts(status, promotion_state);
CREATE INDEX idx_facts_kind    ON facts(fact_kind);
CREATE INDEX idx_git_commit    ON git_anchors(repo_id, valid_from_commit, valid_until_commit);
CREATE INDEX idx_edges_from    ON edges(from_id, edge_kind);
CREATE INDEX idx_edges_to      ON edges(to_id, edge_kind);
CREATE INDEX idx_episodes_sess ON episodes(session_id, created_at);
