import { describe, expect, it } from "vitest";
import type { Fact, ScoredFact } from "../../src/core/types.js";
import { resolveBudget, selectByBudget } from "../../src/inject/budget.js";

const cfg = {
  totalBudgetTokens: 2500,
  maxCards: 15,
  maxCardsPretool: 5,
  budgetFraction: 0.015,
};

function fact(id: string, predicate: string, object: string): Fact {
  return {
    fact_id: `fact_${id}`,
    subject: "repo",
    predicate,
    object,
    fact_kind: "semantic",
    temporal_kind: "static",
    scope: { user_id: "u", workspace_id: "w" },
    status: "active",
    promotion_state: "workspace_active",
    trust_tier: "high",
    sensitivity: "public",
    confidence: 0.9,
    evidence_count: 1,
    contradiction_count: 0,
    injection_count: 0,
    time: { t_created: "t", t_recorded: "t" },
    source: { asserted_by: "deterministic_parser", event_ids: [] },
    tags: [],
  };
}

function scored(f: Fact, score: number): ScoredFact {
  return { fact: f, score };
}

describe("budget", () => {
  it("caps PostCompact higher than PreToolUse", () => {
    expect(resolveBudget("PostCompact", cfg)).toBeGreaterThan(resolveBudget("PreToolUse", cfg));
  });

  it("respects explicit override", () => {
    expect(resolveBudget("SessionStart", cfg, 123)).toBe(123);
  });

  it("selects by utility and respects max cards", () => {
    const facts = Array.from({ length: 20 }, (_, i) =>
      scored(fact(String(i), `pred_${i}`, `value ${i}`), 1),
    );
    const res = selectByBudget(facts, 2500, "SessionStart", cfg);
    expect(res.selected.length).toBeLessThanOrEqual(cfg.maxCards);
  });

  it("applies max_cards_pretool for PreToolUse", () => {
    const facts = Array.from({ length: 20 }, (_, i) =>
      scored(fact(String(i), `pred_${i}`, `value ${i}`), 1),
    );
    const res = selectByBudget(facts, 2500, "PreToolUse", cfg);
    expect(res.selected.length).toBeLessThanOrEqual(cfg.maxCardsPretool);
  });

  it("drops redundant facts with same subject+predicate", () => {
    const a = scored(fact("a", "test_command", "pnpm test"), 1);
    const b = scored(fact("b", "test_command", "pnpm test"), 0.9);
    const res = selectByBudget([a, b], 2500, "SessionStart", cfg);
    expect(res.selected).toHaveLength(1);
    expect(res.omitted.some((o) => o.reason === "redundant")).toBe(true);
  });

  it("omits facts that exceed the token budget", () => {
    const facts = Array.from({ length: 10 }, (_, i) =>
      scored(fact(String(i), `pred_${i}`, "x".repeat(40)), 1),
    );
    const res = selectByBudget(facts, 5, "SessionStart", cfg);
    expect(res.omitted.some((o) => o.reason === "budget")).toBe(true);
  });
});
