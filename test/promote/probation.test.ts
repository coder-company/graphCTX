import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NewFact } from "../../src/core/types.js";
import { Probation } from "../../src/promote/probation.js";
import { EdgesRepo } from "../../src/store/edges.repo.js";
import { FactsRepo } from "../../src/store/facts.repo.js";
import { runMigrations } from "../../src/store/migrate.js";
import { PromotionsRepo } from "../../src/store/promotions.repo.js";

let db: Database.Database;
let facts: FactsRepo;
let edges: EdgesRepo;
let promotions: PromotionsRepo;
let probation: Probation;

const scope = { user_id: "u", workspace_id: "ws1" };

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  facts = new FactsRepo(db);
  edges = new EdgesRepo(db);
  promotions = new PromotionsRepo(db);
  probation = new Probation({
    facts,
    edges,
    promotions,
    workspaceDir: "/nonexistent",
    minProcedureSuccesses: 2,
    minFailureRepeats: 2,
  });
});
afterEach(() => db.close());

const f = (over: Partial<NewFact>): NewFact => ({
  subject: "repo",
  predicate: "test_command",
  object: "npm test",
  fact_kind: "procedural",
  temporal_kind: "static",
  scope,
  trust_tier: "high",
  status: "candidate",
  promotion_state: "session_only",
  source: { asserted_by: "deterministic_parser", event_ids: [] },
  ...over,
});

describe("Probation sweep (session → workspace)", () => {
  it("promotes a high-trust deterministic fact to workspace_active and records audit", () => {
    const fact = facts.insert(f({}));
    const res = probation.sweepSessionToWorkspace(scope);
    expect(res.promoted).toBe(1);
    expect(facts.get(fact.fact_id)!.promotion_state).toBe("workspace_active");
    const audit = promotions.forFact(fact.fact_id);
    expect(audit.length).toBe(1);
    expect(audit[0]!.decision).toBe("promote");
    expect(audit[0]!.gate).toBe("config_evidence");
  });

  it("never promotes a secret (I3)", () => {
    const fact = facts.insert(
      f({ sensitivity: "secret", object: "sk-PLACEHOLDER", predicate: "api_key" }),
    );
    probation.sweepSessionToWorkspace(scope);
    expect(facts.get(fact.fact_id)!.promotion_state).toBe("session_only");
    expect(promotions.forFact(fact.fact_id)[0]!.decision).toBe("reject");
  });

  it("holds a low-trust agent guess as workspace_candidate", () => {
    const fact = facts.insert(
      f({
        trust_tier: "low",
        source: { asserted_by: "agent", event_ids: [] },
        fact_kind: "semantic",
        object: "guess",
      }),
    );
    probation.sweepSessionToWorkspace(scope);
    expect(facts.get(fact.fact_id)!.promotion_state).toBe("workspace_candidate");
  });

  it("rolls back fact state when promotion audit recording fails", () => {
    const fact = facts.insert(f({}));
    const originalRecord = promotions.record.bind(promotions);
    promotions.record = (() => {
      throw new Error("audit failed");
    }) as PromotionsRepo["record"];

    try {
      expect(() => probation.sweepSessionToWorkspace(scope)).toThrow("audit failed");
      const after = facts.get(fact.fact_id)!;
      expect(after.promotion_state).toBe("session_only");
      expect(after.status).toBe("candidate");
      expect(promotions.forFact(fact.fact_id)).toEqual([]);
    } finally {
      promotions.record = originalRecord as PromotionsRepo["record"];
    }
  });
});
