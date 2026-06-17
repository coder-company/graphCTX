import { describe, expect, it } from "vitest";
import type { GitAnchor } from "../../src/core/types.js";
import { isValidAsOf, isValidAsOfSync } from "../../src/git/anchors.js";
import type { Git } from "../../src/git/git.js";

// Linear history: c1 <- c2 <- c3 ; branch "feat" off c2: c2 <- f1
// Ancestry oracle for the test DAG.
const PARENTS: Record<string, string[]> = {
  c1: [],
  c2: ["c1"],
  c3: ["c2"],
  f1: ["c2"],
};

function isAncestor(a: string, b: string): boolean {
  if (a === b) return true;
  const stack = [...(PARENTS[b] ?? [])];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === a) return true;
    stack.push(...(PARENTS[cur] ?? []));
  }
  return false;
}

describe("commit-anchored validity (I-temporal)", () => {
  it("valid when valid_from is an ancestor of HEAD", () => {
    const a: GitAnchor = { valid_from_commit: "c1" };
    expect(isValidAsOfSync(a, "c3", "main", isAncestor)).toBe(true);
  });

  it("invalid when valid_from is not yet reachable from HEAD", () => {
    const a: GitAnchor = { valid_from_commit: "c3" };
    expect(isValidAsOfSync(a, "c2", "main", isAncestor)).toBe(false);
  });

  it("invalid once valid_until is reachable from HEAD", () => {
    const a: GitAnchor = { valid_from_commit: "c1", valid_until_commit: "c2" };
    expect(isValidAsOfSync(a, "c3", "main", isAncestor)).toBe(false);
    expect(isValidAsOfSync(a, "c1", "main", isAncestor)).toBe(true);
  });

  it("invalid when the anchor repo id does not match the current repo id", () => {
    const a: GitAnchor = { repo_id: "repo-other", valid_from_commit: "c1" };
    expect(isValidAsOfSync(a, "c3", "main", isAncestor, "repo-current")).toBe(false);
    expect(isValidAsOfSync(a, "c3", "main", isAncestor, "repo-other")).toBe(true);
  });

  it("does not leak a branch-scoped fact onto a disjoint branch", () => {
    // fact introduced on feat at f1, branch-scoped to "feat"
    const a: GitAnchor = { branch: "feat", introduced_by_commit: "f1" };
    // On main@c3, f1 is NOT an ancestor → not valid here
    expect(isValidAsOfSync(a, "c3", "main", isAncestor)).toBe(false);
    // On feat@f1, same branch → valid
    expect(isValidAsOfSync(a, "f1", "feat", isAncestor)).toBe(true);
  });

  it("non-git facts are always valid", () => {
    expect(isValidAsOfSync(undefined, "c3", "main", isAncestor)).toBe(true);
  });

  it("recognizes a cross-branch cherry-picked change by patch-id equivalence", async () => {
    const calls: Array<[string, string, string | undefined]> = [];
    const git = {
      isAncestor: async () => false,
      hasPatchEquivalent: async (target: string, head: string, patchId?: string) => {
        calls.push([target, head, patchId]);
        return target === "x1" && head === "y1" && patchId === "pid-x1";
      },
    } as unknown as Git;
    const anchor: GitAnchor = {
      branch: "feat",
      introduced_by_commit: "x1",
      valid_from_commit: "x1",
      patch_id: "pid-x1",
    };

    await expect(isValidAsOf(git, anchor, "y1", "main")).resolves.toBe(true);
    expect(calls).toEqual([["x1", "y1", "pid-x1"]]);
  });

  it("does not use patch-id equivalence to revive same-branch rebased SHAs", async () => {
    let patchEquivalenceCalls = 0;
    const git = {
      isAncestor: async () => false,
      hasPatchEquivalent: async () => {
        patchEquivalenceCalls++;
        return true;
      },
    } as unknown as Git;
    const anchor: GitAnchor = {
      branch: "feat",
      introduced_by_commit: "old",
      valid_from_commit: "old",
      patch_id: "pid-old",
    };

    await expect(isValidAsOf(git, anchor, "rebased", "feat")).resolves.toBe(false);
    expect(patchEquivalenceCalls).toBe(0);
  });
});
