import { describe, expect, it } from "vitest";
import type { Fact } from "../../src/core/types.js";
import {
  type PromotionContext,
  sessionToWorkspace,
  workspaceToUser,
} from "../../src/promote/gates.js";

const ctx = (over: Partial<PromotionContext> = {}): PromotionContext => ({
  hasUnresolvedConflict: false,
  minProcedureSuccesses: 2,
  minFailureRepeats: 2,
  ...over,
});

const fact = (over: Partial<Fact>): Fact =>
  ({
    fact_id: "f1",
    subject: "repo",
    predicate: "test_command",
    object: "npm test",
    fact_kind: "procedural",
    temporal_kind: "static",
    scope: { user_id: "u", workspace_id: "ws1" },
    status: "active",
    promotion_state: "session_only",
    trust_tier: "high",
    sensitivity: "public",
    confidence: 0.8,
    evidence_count: 1,
    contradiction_count: 0,
    injection_count: 0,
    time: { t_observed: "t", t_created: "t", t_recorded: "t" },
    source: { asserted_by: "deterministic_parser", event_ids: [] },
    tags: [],
    ...over,
  }) as Fact;

describe("sessionToWorkspace hard gates (SPEC §12)", () => {
  it("rejects secrets", () => {
    const d = sessionToWorkspace(fact({ sensitivity: "secret" }), ctx());
    expect(d.kind).toBe("reject");
    expect(d.gate).toBe("secret");
  });

  it("rejects task_state (session-local)", () => {
    const d = sessionToWorkspace(fact({ fact_kind: "task_state" }), ctx());
    expect(d.kind).toBe("reject");
  });

  it("rejects bad lifecycle (disputed/expired)", () => {
    expect(sessionToWorkspace(fact({ status: "disputed" }), ctx()).kind).toBe("reject");
    expect(sessionToWorkspace(fact({ status: "expired" }), ctx()).kind).toBe("reject");
  });

  it("holds candidate when there is an unresolved conflict", () => {
    const d = sessionToWorkspace(fact({}), ctx({ hasUnresolvedConflict: true }));
    expect(d.kind).toBe("candidate");
    expect(d.gate).toBe("needs_resolution");
  });

  it("promotes high-trust deterministic repo evidence", () => {
    const d = sessionToWorkspace(fact({}), ctx());
    expect(d.kind).toBe("promote");
    expect(d.gate).toBe("config_evidence");
  });

  it("promotes a user-explicit repo-scoped fact", () => {
    const d = sessionToWorkspace(
      fact({
        source: {
          asserted_by: "user",
          event_ids: [],
          raw_quote: "in this repo we deploy via ship.sh",
        },
        trust_tier: "low",
        fact_kind: "decision",
      }),
      ctx(),
    );
    expect(d.kind).toBe("promote");
    expect(d.gate).toBe("user_explicit");
  });

  it("promotes a verified procedure once successes >= threshold", () => {
    const f = fact({ source: { asserted_by: "agent", event_ids: [] }, trust_tier: "low" });
    expect(sessionToWorkspace(f, ctx({ procSuccesses: 1 })).kind).toBe("candidate");
    expect(sessionToWorkspace(f, ctx({ procSuccesses: 2 })).kind).toBe("promote");
  });

  it("promotes a constraint repeated across sessions", () => {
    const f = fact({
      fact_kind: "constraint",
      source: { asserted_by: "agent", event_ids: [] },
      trust_tier: "low",
    });
    expect(sessionToWorkspace(f, ctx({ sessionsObserved: 1 })).kind).toBe("candidate");
    expect(sessionToWorkspace(f, ctx({ sessionsObserved: 2 })).kind).toBe("promote");
  });

  it("holds candidate when no gate is satisfied", () => {
    const f = fact({
      source: { asserted_by: "agent", event_ids: [] },
      trust_tier: "low",
      fact_kind: "semantic",
    });
    expect(sessionToWorkspace(f, ctx()).kind).toBe("candidate");
  });
});

describe("workspaceToUser hard gates (explicit-only v1)", () => {
  it("rejects secrets", () => {
    expect(workspaceToUser(fact({ sensitivity: "credential", fact_kind: "preference" })).kind).toBe(
      "reject",
    );
  });

  it("rejects non-profile material", () => {
    expect(workspaceToUser(fact({ fact_kind: "decision" })).kind).toBe("reject");
  });

  it("promotes an explicit global user preference", () => {
    const d = workspaceToUser(
      fact({
        fact_kind: "preference",
        source: {
          asserted_by: "user",
          event_ids: [],
          raw_quote: "always use functional TS in every project",
        },
        trust_tier: "low",
      }),
    );
    expect(d.kind).toBe("promote");
  });

  it("rejects a repo convention as a user preference", () => {
    const d = workspaceToUser(
      fact({
        fact_kind: "preference",
        source: { asserted_by: "deterministic_parser", event_ids: [] },
      }),
    );
    expect(d.kind).toBe("reject");
    expect(d.gate).toBe("repo_convention");
  });
});
