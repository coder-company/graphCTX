import type { Git, SHA } from "./git.js";

export type GitEvent = "fast-forward" | "merge" | "rebase" | "revert" | "switch" | "none";

// Best-effort classification of a HEAD transition (SPEC §8). M0 uses this only
// for branch-switch detection in capture; full merge/revert semantics are M3.
export async function detectEvent(git: Git, prevHead: SHA, newHead: SHA): Promise<GitEvent> {
  if (prevHead === newHead) return "none";
  if (await git.isAncestor(prevHead, newHead)) return "fast-forward";
  if (await git.isAncestor(newHead, prevHead)) return "switch";
  const base = await git.mergeBase(prevHead, newHead);
  if (base && base !== prevHead && base !== newHead) return "switch";
  return "switch";
}
