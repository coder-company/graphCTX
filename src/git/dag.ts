import type { Fact } from "../core/types.js";
import type { FactsRepo } from "../store/facts.repo.js";
import type { Git, SHA } from "./git.js";

// Git-DAG event semantics (SPEC §8, M3). graphCTX anchors facts to commits; when
// HEAD moves we must classify HOW it moved so fact validity stays correct across
// branch switches, merges, rebases and reverts.
export type DagEventKind =
  | "fast_forward" // HEAD advanced linearly (prev is ancestor of next)
  | "merge" // next has prev + another parent merged in
  | "rebase" // history rewritten; prev not an ancestor, no shared merge-base move
  | "revert" // a prior commit's change was undone
  | "switch" // moved to a different branch/line of history
  | "noop";

export interface DagEvent {
  kind: DagEventKind;
  from: SHA;
  to: SHA;
  fromBranch?: string;
  toBranch?: string;
}

// Classify a HEAD transition. Best-effort + fail-soft: unknown → "switch"
// (the conservative choice — forces a full validity recompute).
export async function detectEvent(
  git: Git,
  from: SHA,
  to: SHA,
  fromBranch?: string,
  toBranch?: string,
): Promise<DagEvent> {
  const base = { from, to, fromBranch, toBranch };
  if (from === to) return { ...base, kind: "noop" };

  try {
    // Linear advance: old HEAD is an ancestor of new HEAD.
    if (await git.isAncestor(from, to)) {
      const parents = await commitParents(git, to);
      if (parents.length > 1) return { ...base, kind: "merge" };
      // A revert commit advances linearly but undoes an earlier change.
      if (await isRevertCommit(git, to)) return { ...base, kind: "revert" };
      return { ...base, kind: "fast_forward" };
    }

    // New HEAD is behind old HEAD (reset/checkout backwards) on the same line.
    if (await git.isAncestor(to, from)) return { ...base, kind: "switch" };

    // Divergent. If branch label changed → switch; else rewritten history → rebase.
    if (fromBranch && toBranch && fromBranch !== toBranch) return { ...base, kind: "switch" };
    const mb = await git.mergeBase(from, to);
    if (mb && (await isRevertCommit(git, to))) return { ...base, kind: "revert" };
    return { ...base, kind: "rebase" };
  } catch {
    return { ...base, kind: "switch" };
  }
}

// On a REVERT, a previously-expired fact whose invalidating change was undone
// should become live again (SPEC §8): clear valid_until + invalidated_by and
// set status active. We re-validate facts whose valid_until_commit is no longer
// reachable from HEAD (the invalidating commit was reverted away).
export async function revalidateOnRevert(
  git: Git,
  facts: FactsRepo,
  head: SHA,
  currentBranch: string,
): Promise<Fact[]> {
  const restored: Fact[] = [];
  let expired: Fact[];
  try {
    expired = facts.expiredWithValidUntil();
  } catch {
    return restored;
  }
  for (const f of expired) {
    const vu = f.git?.valid_until_commit;
    if (!vu) continue;
    // If the invalidating commit is no longer an ancestor of HEAD, the change
    // that expired this fact was reverted → bring the prior fact back to active.
    const stillInvalid = await git.isAncestor(vu, head);
    if (!stillInvalid) {
      facts.reactivate(f.fact_id);
      restored.push(f);
    }
  }
  return restored;
}

async function commitParents(git: Git, sha: SHA): Promise<string[]> {
  try {
    const raw = await git.parentsOf(sha);
    return raw;
  } catch {
    return [];
  }
}

// Heuristic: a commit is a revert if its subject is a git "Revert ..." or it
// records a Reverts-this trailer. Best-effort; fail-soft to false.
async function isRevertCommit(git: Git, sha: SHA): Promise<boolean> {
  try {
    const msg = await git.commitMessage(sha);
    return /^revert\b/i.test(msg.trim()) || /\bThis reverts commit\b/i.test(msg);
  } catch {
    return false;
  }
}
