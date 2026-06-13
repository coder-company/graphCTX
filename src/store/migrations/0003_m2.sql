-- M2: DB-backed anti-repetition ledger for cross-channel, cross-process
-- idempotency. A fact injected via a hook must not be re-injected via an MCP
-- rider in the same session within the TTL (SPEC §15, GAMEPLAN §5.2).
CREATE TABLE inject_ledger (
  session_id   TEXT NOT NULL,
  fact_id      TEXT NOT NULL,
  event_type   TEXT,
  injected_at  TEXT NOT NULL,
  PRIMARY KEY (session_id, fact_id)
);

CREATE INDEX idx_inject_ledger_session ON inject_ledger(session_id, injected_at);
