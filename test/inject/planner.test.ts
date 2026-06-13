import { describe, expect, it } from "vitest";
import type { InjectionContext, NewFact } from "../../src/core/types.js";
import { InjectionPlanner } from "../../src/inject/planner.js";
import { openDb } from "../../src/store/db.js";
import { FactsRepo } from "../../src/store/facts.repo.js";

const gateConfig = {
  enabledEvents: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostCompact"],
  driftThreshold: 0.35,
};
const budgetConfig = {
  totalBudgetTokens: 2500,
  maxCards: 15,
  maxCardsPretool: 5,
  budgetFraction: 0.015,
};

function activeFact(over: Partial<NewFact> = {}): NewFact {
  return {
    subject: "repo",
    predicate: "test_command",
    object: "pnpm test",
    fact_kind: "semantic",
    temporal_kind: "static",
    scope: { user_id: "u", workspace_id: "w" },
    trust_tier: "high",
    status: "active",
    promotion_state: "workspace_active",
    source: { asserted_by: "deterministic_parser", event_ids: [] },
    ...over,
  };
}

function ctx(event: InjectionContext["event"]): InjectionContext {
  return {
    event,
    scope: { user_id: "u", workspace_id: "w", session_id: "s" },
    git: { repo_id: "w", head: "", branch: "" },
    user_prompt: "run the tests",
  };
}

describe("injection planner (core loop)", () => {
  it("PostCompact produces a capsule with provenance tags (I7)", async () => {
    const db = openDb(":memory:");
    const facts = new FactsRepo(db);
    facts.insert(activeFact());
    const planner = new InjectionPlanner({
      facts,
      git: null,
      workspaceDir: process.cwd(),
      gateConfig,
      budgetConfig,
    });
    const capsule = await planner.plan(ctx("PostCompact"));
    expect(capsule.markdown).toContain("pnpm test");
    expect(capsule.markdown).toMatch(/\[mem:[^\]]+\]/); // I7 provenance
    expect(capsule.token_count).toBeGreaterThan(0);
  });

  it("returns EMPTY capsule when the gate declines", async () => {
    const db = openDb(":memory:");
    const facts = new FactsRepo(db);
    facts.insert(activeFact());
    const planner = new InjectionPlanner({
      facts,
      git: null,
      workspaceDir: process.cwd(),
      gateConfig,
      budgetConfig,
    });
    const capsule = await planner.plan(ctx("PostToolUse"));
    expect(capsule.markdown).toBe("");
    expect(capsule.cards).toHaveLength(0);
  });

  it("anti-repetition: a fact is not re-injected within the same session", async () => {
    const db = openDb(":memory:");
    const facts = new FactsRepo(db);
    facts.insert(activeFact());
    const planner = new InjectionPlanner({
      facts,
      git: null,
      workspaceDir: process.cwd(),
      gateConfig,
      budgetConfig,
    });
    const first = await planner.plan(ctx("PostCompact"));
    expect(first.cards.length).toBeGreaterThan(0);
    const second = await planner.plan(ctx("SessionStart"));
    expect(second.cards.length).toBe(0); // already injected this session
  });

  it("I4: a do_not_edit fact for a missing file is not injected", async () => {
    const db = openDb(":memory:");
    const facts = new FactsRepo(db);
    facts.insert(
      activeFact({
        subject: "src/does-not-exist.gen.ts",
        predicate: "do_not_edit",
        object: true,
        fact_kind: "constraint",
        git: { path_globs: ["src/does-not-exist.gen.ts"] },
      }),
    );
    const planner = new InjectionPlanner({
      facts,
      git: null,
      workspaceDir: process.cwd(),
      gateConfig,
      budgetConfig,
    });
    const capsule = await planner.plan(ctx("PostCompact"));
    expect(capsule.cards.find((c) => c.fact_id)).toBeUndefined();
  });
});
