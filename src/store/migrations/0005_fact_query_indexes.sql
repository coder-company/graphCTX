-- M4: hot-path fact lookup indexes.
--
-- Retrieval, injection, boot capsules, and MCP listing all ask for active facts
-- within a user/workspace/session scope. Earlier migrations had separate status
-- and scope indexes; this composite index lets SQLite satisfy the common
-- status+scope predicate directly.
CREATE INDEX idx_facts_status_scope ON facts(
  status,
  scope_user_id,
  scope_workspace_id,
  scope_session_id
);
