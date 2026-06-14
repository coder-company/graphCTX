import { describe, expect, it } from "vitest";
import { detectEvent } from "../../src/git/dag.js";
import type { Git } from "../../src/git/git.js";

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
});
