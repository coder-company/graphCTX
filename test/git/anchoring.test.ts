import { describe, expect, it } from "vitest";
import type { GitAnchor } from "../../src/core/types.js";
import { anchorAtHead, isValidAsOfSync } from "../../src/git/anchors.js";

// A tiny commit DAG:  c1 → c2 → c3 (main),  c2 → f1 (feature)
// isAncestor(a,b): is a reachable from b?
const PARENTS: Record<string, string[]> = {
  c1: [],
  c2: ["c1"],
  c3: ["c2"],
  f1: ["c2"],
};
function isAncestor(a: string, b: string): boolean {
  if (a === b) return true;
  const seen = new Set<string>();
  const stack = [...(PARENTS[b] ?? [])];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === a) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...(PARENTS[cur] ?? []));
  }
  return false;
}

describe("commit anchoring + branch filtering (M1 §4)", () => {
  it("non-ancestor valid_from is filtered out at HEAD", () => {
    // fact introduced at c3 (main tip); HEAD is c2 → c3 is NOT an ancestor of c2.
    const anchor: GitAnchor = { valid_from_commit: "c3" };
    expect(isValidAsOfSync(anchor, "c2", "main", isAncestor)).toBe(false);
  });

  it("ancestor valid_from is valid at HEAD", () => {
    const anchor: GitAnchor = { valid_from_commit: "c1" };
    expect(isValidAsOfSync(anchor, "c3", "main", isAncestor)).toBe(true);
  });

  it("branch-disjoint fact is not valid on an unrelated branch", () => {
    // fact introduced on feature at f1; HEAD is c3 on main → f1 not ancestor of c3.
    const anchor: GitAnchor = { branch: "feature", introduced_by_commit: "f1" };
    expect(isValidAsOfSync(anchor, "c3", "main", isAncestor)).toBe(false);
  });

  it("same-branch fact is valid", () => {
    const anchor: GitAnchor = { branch: "main", introduced_by_commit: "c2" };
    expect(isValidAsOfSync(anchor, "c3", "main", isAncestor)).toBe(true);
  });

  it("expired (valid_until reached) fact is filtered", () => {
    const anchor: GitAnchor = { valid_from_commit: "c1", valid_until_commit: "c2" };
    // valid_until c2 is an ancestor of c3 → fact no longer valid at c3.
    expect(isValidAsOfSync(anchor, "c3", "main", isAncestor)).toBe(false);
  });

  it("anchorAtHead fills missing fields but preserves existing", () => {
    const filled = anchorAtHead(
      { valid_from_commit: "c1", path_globs: ["a.ts"] },
      {
        repoId: "repo_x",
        head: "c3",
        branch: "main",
      },
    );
    expect(filled.valid_from_commit).toBe("c1"); // preserved
    expect(filled.introduced_by_commit).toBe("c3"); // filled
    expect(filled.repo_id).toBe("repo_x");
    expect(filled.branch).toBe("main");
    expect(filled.path_globs).toEqual(["a.ts"]);
  });
});
