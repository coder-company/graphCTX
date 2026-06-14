import type { GitAnchor } from "../core/types.js";
import type { Git, SHA } from "./git.js";

// Build a commit anchor for a fact being durably recorded/promoted at HEAD
// (M1 §4). Preserves any existing anchor fields; fills valid_from/introduced_by
// + branch + repo_id when they are missing so every promoted fact is
// commit-valid (I5/SPEC §8).
export function anchorAtHead(
  existing: GitAnchor | undefined,
  git: { repoId: string; head: SHA; branch: string },
): GitAnchor {
  return {
    ...existing,
    repo_id: existing?.repo_id ?? git.repoId,
    branch: existing?.branch ?? git.branch,
    introduced_by_commit: existing?.introduced_by_commit ?? git.head,
    valid_from_commit: existing?.valid_from_commit ?? git.head,
  };
}

// Commit-anchored validity (SPEC §8). A fact is valid at HEAD iff:
//   (valid_from == null OR isAncestor(valid_from, HEAD))
//   AND (valid_until == null OR NOT isAncestor(valid_until, HEAD))
//   AND (branch == null OR branch == current OR isAncestor(introduced_by, HEAD))
export async function isValidAsOf(
  git: Git,
  anchor: GitAnchor | undefined,
  head: SHA,
  currentBranch: string,
): Promise<boolean> {
  if (!anchor) return true; // non-git facts are always valid

  if (anchor.valid_from_commit) {
    if (!(await git.isAncestor(anchor.valid_from_commit, head))) return false;
  }
  if (anchor.valid_until_commit) {
    if (await git.isAncestor(anchor.valid_until_commit, head)) return false;
  }
  if (anchor.branch && anchor.branch !== currentBranch) {
    if (anchor.introduced_by_commit) {
      if (!(await git.isAncestor(anchor.introduced_by_commit, head))) return false;
    } else {
      // branch-scoped with no anchor commit and different branch -> not valid here
      return false;
    }
  }
  return true;
}

// Synchronous variant for tests / non-git stores: validity with a provided
// ancestry oracle. Keeps the rule logic unit-testable without a live repo.
export function isValidAsOfSync(
  anchor: GitAnchor | undefined,
  head: SHA,
  currentBranch: string,
  isAncestor: (a: SHA, b: SHA) => boolean,
): boolean {
  if (!anchor) return true;
  if (anchor.valid_from_commit && !isAncestor(anchor.valid_from_commit, head)) return false;
  if (anchor.valid_until_commit && isAncestor(anchor.valid_until_commit, head)) return false;
  if (anchor.branch && anchor.branch !== currentBranch) {
    if (anchor.introduced_by_commit) {
      if (!isAncestor(anchor.introduced_by_commit, head)) return false;
    } else {
      return false;
    }
  }
  return true;
}
