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
  currentRepoId?: string,
): Promise<boolean> {
  if (!anchor) return true; // non-git facts are always valid
  if (anchor.repo_id && currentRepoId && anchor.repo_id !== currentRepoId) return false;
  const allowPatchEquivalence = anchor.branch !== undefined && anchor.branch !== currentBranch;
  const represented = new Map<SHA, boolean>();
  const isRepresentedAtHead = async (commit: SHA): Promise<boolean> => {
    const cached = represented.get(commit);
    if (cached !== undefined) return cached;
    const byAncestry = await git.isAncestor(commit, head);
    const ok =
      byAncestry ||
      (allowPatchEquivalence &&
        (await git.hasPatchEquivalent(commit, head, anchorPatchIdFor(anchor, commit))));
    represented.set(commit, ok);
    return ok;
  };

  if (anchor.valid_from_commit) {
    if (!(await isRepresentedAtHead(anchor.valid_from_commit))) return false;
  }
  if (anchor.valid_until_commit) {
    if (await isRepresentedAtHead(anchor.valid_until_commit)) return false;
  }
  if (anchor.branch && anchor.branch !== currentBranch) {
    if (anchor.introduced_by_commit) {
      if (!(await isRepresentedAtHead(anchor.introduced_by_commit))) return false;
    } else {
      // branch-scoped with no anchor commit and different branch -> not valid here
      return false;
    }
  }
  return true;
}

function anchorPatchIdFor(anchor: GitAnchor, commit: SHA): string | undefined {
  if (commit !== anchor.valid_from_commit && commit !== anchor.introduced_by_commit)
    return undefined;
  return anchor.patch_id;
}

// Synchronous variant for tests / non-git stores: validity with a provided
// ancestry oracle. Keeps the rule logic unit-testable without a live repo.
export function isValidAsOfSync(
  anchor: GitAnchor | undefined,
  head: SHA,
  currentBranch: string,
  isAncestor: (a: SHA, b: SHA) => boolean,
  currentRepoId?: string,
): boolean {
  if (!anchor) return true;
  if (anchor.repo_id && currentRepoId && anchor.repo_id !== currentRepoId) return false;
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
