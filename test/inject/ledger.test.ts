import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ScoredFact } from "../../src/core/types.js";
import { Ledger } from "../../src/inject/ledger.js";
import { runMigrations } from "../../src/store/migrate.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});
afterEach(() => db.close());

function sf(id: string, kind = "semantic"): ScoredFact {
  return {
    fact: {
      fact_id: id,
      subject: "repo",
      predicate: "p",
      object: "o",
      fact_kind: kind as ScoredFact["fact"]["fact_kind"],
      temporal_kind: "static",
      scope: { user_id: "u", workspace_id: "w" },
      status: "active",
      promotion_state: "workspace_active",
      trust_tier: "high",
      sensitivity: "public",
      confidence: 0.5,
      evidence_count: 1,
      contradiction_count: 0,
      injection_count: 0,
      time: { t_observed: "2026-01-01", t_created: "2026-01-01", t_recorded: "2026-01-01" },
      source: { asserted_by: "user", event_ids: [] },
      tags: [],
    },
    score: 1,
  };
}

describe("anti-repetition ledger (M2 — DB-backed, cross-channel)", () => {
  it("suppresses a fact already injected this session", () => {
    const l = new Ledger(db);
    l.record("s1", [sf("a")], "PostCompact");
    const filtered = l.removeRecentlyInjected([sf("a"), sf("b")], "s1");
    expect(filtered.map((f) => f.fact.fact_id)).toEqual(["b"]);
  });

  it("idempotency holds ACROSS processes via the shared DB", () => {
    // Process 1 (e.g. a hook) records the injection.
    const hookLedger = new Ledger(db);
    hookLedger.record("s1", [sf("a")], "PreToolUse");

    // Process 2 (e.g. the MCP rider) sees a fresh in-memory ledger but the same
    // DB — it must still suppress the already-pushed fact.
    const mcpLedger = new Ledger(db);
    const filtered = mcpLedger.removeRecentlyInjected([sf("a"), sf("b")], "s1");
    expect(filtered.map((f) => f.fact.fact_id)).toEqual(["b"]);
  });

  it("never suppresses open loops (they resurface until resolved)", () => {
    const l = new Ledger(db);
    l.record("s1", [sf("loop", "open_loop")], "PostCompact");
    const filtered = l.removeRecentlyInjected([sf("loop", "open_loop")], "s1");
    expect(filtered.map((f) => f.fact.fact_id)).toEqual(["loop"]);
  });

  it("expires entries after the TTL", () => {
    const l = new Ledger(db, 0); // TTL=0 → nothing is ever "recent"
    l.record("s1", [sf("a")], "PostCompact");
    const filtered = l.removeRecentlyInjected([sf("a")], "s1");
    expect(filtered.map((f) => f.fact.fact_id)).toEqual(["a"]);
  });

  it("degrades to in-memory only when no DB is provided (I9)", () => {
    const l = new Ledger(null);
    l.record("s1", [sf("a")], "PostCompact");
    expect(l.removeRecentlyInjected([sf("a"), sf("b")], "s1").map((f) => f.fact.fact_id)).toEqual([
      "b",
    ]);
  });
});
