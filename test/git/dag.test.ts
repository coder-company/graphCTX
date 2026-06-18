import { describe, expect, it } from "vitest";
import type { Fact } from "../../src/core/types.js";
import { detectEvent, revalidateOnRevert } from "../../src/git/dag.js";
import type { Git } from "../../src/git/git.js";
import type { FactsRepo } from "../../src/store/facts.repo.js";

// Tiny DAG:  c0 ── c1 ── c2 (revert)   and feat branch b1 off c0.
const ANCESTRY: Record<string, string[]> = {
  c0: ["c0"],
  c1: ["c0", "c1"],
  c2: ["c0", "c1", "c2"],
  b1: ["c0", "b1"],
};
const PARENTS: Record<string, string[]> = { c1: ["c0"], c2: ["c1"], merge: ["c1", "b1"] };
const MESSAGES: Record<string, string> = { c2: 'Revert "add thing"\n\nThis reverts commit c1.' };

function fakeGit(): Git {
  return {
    isAncestor: async (a: string, b: string) => ANCESTRY[b]?.includes(a) ?? false,
    mergeBase: async () => "c0",
    parentsOf: async (sha: string) => PARENTS[sha] ?? [],
    commitMessage: async (sha: string) => MESSAGES[sha] ?? "regular commit",
  } as unknown as Git;
}

function fact(
  factId: string,
  validUntil: string,
  git: Partial<Fact["git"]> = {},
  status: Fact["status"] = "expired",
): Fact {
  return {
    fact_id: factId,
    subject: "repo",
    predicate: "test_command",
    object: "vitest run",
    fact_kind: "procedural",
    temporal_kind: "static",
    scope: { user_id: "u", workspace_id: "w" },
    status,
    promotion_state: "workspace_active",
    trust_tier: "high",
    sensitivity: "public",
    confidence: 0.9,
    evidence_count: 1,
    contradiction_count: 0,
    injection_count: 0,
    time: {
      t_observed: "2026-01-01T00:00:00.000Z",
      t_created: "2026-01-01T00:00:00.000Z",
      t_recorded: "2026-01-01T00:00:00.000Z",
      t_expired: "2026-01-02T00:00:00.000Z",
    },
    git: { ...git, valid_until_commit: validUntil },
    source: { asserted_by: "deterministic_parser", event_ids: [] },
    tags: [],
  };
}

describe("git/dag detectEvent", () => {
  const git = fakeGit();

  it("noop when HEAD unchanged", async () => {
    expect((await detectEvent(git, "c1", "c1")).kind).toBe("noop");
  });

  it("fast_forward on linear advance", async () => {
    expect((await detectEvent(git, "c0", "c1")).kind).toBe("fast_forward");
  });

  it("merge when target has >1 parent", async () => {
    const g = { ...fakeGit(), isAncestor: async () => true } as unknown as Git;
    expect((await detectEvent(g, "c1", "merge")).kind).toBe("merge");
  });

  it("revert when target message is a revert", async () => {
    expect((await detectEvent(git, "c1", "c2")).kind).toBe("revert");
  });

  it("switch when branch label changes and history diverges", async () => {
    expect((await detectEvent(git, "c1", "b1", "main", "feat")).kind).toBe("switch");
  });

  it("revalidateOnRevert skips bad historical anchors and restores closed facts", async () => {
    const restoredIds: string[] = [];
    const facts = {
      closedWithValidUntil: () => [
        fact("bad", "missing"),
        fact("foreign-branch", "gone", {
          branch: "feature",
          introduced_by_commit: "feature-intro",
        }),
        fact("good-expired", "gone"),
        fact("good-superseded", "gone", {}, "superseded"),
      ],
      reactivate: (id: string) => {
        restoredIds.push(id);
      },
    } as unknown as FactsRepo;
    const gitWithBadAnchor = {
      isAncestor: async (target: string) => {
        if (target === "missing") throw new Error("unknown revision");
        if (target === "feature-intro") return false;
        return false;
      },
      hasPatchEquivalent: async () => false,
      isRevertedBy: async () => false,
    } as unknown as Git;

    const restored = await revalidateOnRevert(gitWithBadAnchor, facts, "head", "main");

    expect(restored.map((f) => f.fact_id)).toEqual(["good-expired", "good-superseded"]);
    expect(restoredIds).toEqual(["good-expired", "good-superseded"]);
  });
});
