import { describe, expect, it } from "vitest";
import type { Fact } from "../../src/core/types.js";
import { renderCard } from "../../src/render/cards.js";

function fact(over: Partial<Fact> = {}): Fact {
  return {
    fact_id: "fact_test",
    subject: "repo",
    predicate: "test_command",
    object: "pnpm test",
    fact_kind: "procedural",
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
    time: { t_observed: "t", t_created: "t", t_recorded: "t" },
    source: { asserted_by: "deterministic_parser", event_ids: [] },
    tags: [],
    ...over,
  };
}

describe("renderCard", () => {
  it("does not claim HEAD verification without a verification anchor", () => {
    const card = renderCard(fact());
    expect(card.markdown).toContain("Run tests with: pnpm test.");
    expect(card.markdown).not.toContain("Verified @ HEAD");
  });

  it("shows commit verification only when a commit anchor exists", () => {
    const card = renderCard(
      fact({
        git: { valid_from_commit: "abcdef1234567890" },
      }),
    );
    expect(card.markdown).toContain("Verified @ abcdef1.");
  });
});
