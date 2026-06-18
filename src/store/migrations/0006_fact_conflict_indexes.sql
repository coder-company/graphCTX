-- M5: invalidation conflict lookup index.
--
-- Every durable write asks for existing facts with the same
-- subject/predicate inside the current scope before classifying temporal
-- relations. Keep that lookup on one composite index instead of intersecting
-- the older subject/predicate and scope indexes.
CREATE INDEX idx_facts_sp_scope_status ON facts(
  subject_id,
  predicate,
  scope_user_id,
  scope_workspace_id,
  scope_session_id,
  status
);
