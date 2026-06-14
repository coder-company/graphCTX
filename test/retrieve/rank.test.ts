import { describe, expect, it } from "vitest";
import type { Fact, ScoredFact } from "../../src/core/types.js";
import { fuse } from "../../src/retrieve/rank.js";

function fact(over: Partial<Fact>): Fact {
  return {
    fact_id: Math.random().toString(36).slice(2),
    subject: "repo",
    predicate: "p",
    object: "o",
    fact_kind: "semantic",
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
    time: { t_created: "2026-01-01T00:00:00Z", t_recorded: "2026-01-01T00:00:00Z" },
    source: { asserted_by: "user", event_ids: [] },
    tags: [],
    ...over,
  };
}

describe("fuse — confidence + recency rerank (M2, S5)", () => {
  it("higher confidence wins when base scores tie", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const a: ScoredFact = { fact: fact({ object: "a", confidence: 0.2 }), score: 1 };
    const b: ScoredFact = { fact: fact({ object: "b", confidence: 0.95 }), score: 1 };
    const out = fuse([a, b], now);
    expect(out[0]!.fact.object).toBe("b");
  });

  it("more recent wins when base score + confidence tie", () => {
    const now = Date.parse("2026-02-01T00:00:00Z");
    const old: ScoredFact = {
      fact: fact({
        object: "old",
        time: { t_created: "2025-06-01T00:00:00Z", t_recorded: "2025-06-01T00:00:00Z" },
      }),
      score: 1,
    };
    const fresh: ScoredFact = {
      fact: fact({
        object: "fresh",
        time: { t_created: "2026-01-30T00:00:00Z", t_recorded: "2026-01-30T00:00:00Z" },
      }),
      score: 1,
    };
    const out = fuse([old, fresh], now);
    expect(out[0]!.fact.object).toBe("fresh");
  });

  it("a strongly-relevant older fact still outranks a weak fresh one (bounded factors)", () => {
    const now = Date.parse("2026-02-01T00:00:00Z");
    const strongOld: ScoredFact = {
      fact: fact({
        object: "strong",
        confidence: 0.9,
        time: { t_created: "2025-01-01T00:00:00Z", t_recorded: "2025-01-01T00:00:00Z" },
      }),
      score: 5,
    };
    const weakFresh: ScoredFact = {
      fact: fact({
        object: "weak",
        confidence: 0.9,
        time: { t_created: "2026-01-31T00:00:00Z", t_recorded: "2026-01-31T00:00:00Z" },
      }),
      score: 1,
    };
    const out = fuse([strongOld, weakFresh], now);
    expect(out[0]!.fact.object).toBe("strong");
  });

  it("is deterministic across runs (content-key tiebreak)", () => {
    const now = Date.now();
    const a: ScoredFact = { fact: fact({ object: "alpha" }), score: 1 };
    const b: ScoredFact = { fact: fact({ object: "beta" }), score: 1 };
    const r1 = fuse([a, b], now).map((s) => s.fact.object);
    const r2 = fuse([b, a], now).map((s) => s.fact.object);
    expect(r1).toEqual(r2);
  });
});
