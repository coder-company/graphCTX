import { createHash } from "node:crypto";
import type { ConflictNote, Fact, ScoredFact } from "../core/types.js";
import { asClaim } from "../security/sanitize.js";
import { redactSecretValue, redactSecrets } from "../security/secrets.js";
import { byPrecedence, precedenceRank } from "./precedence.js";

export interface ResolveResult {
  // Facts that remain injectable after precedence resolution (winners only per
  // (subject,predicate) group; losers are suppressed but surfaced as conflicts).
  resolved: ScoredFact[];
  conflicts: ConflictNote[];
}

// Conflict & precedence resolution (SPEC §14). Group active facts by
// (subject,predicate); within each group rank by precedence. The winner stays
// injectable; contradictory losers are suppressed and surfaced as a conflict
// note so the agent sees WHY one value beat another.
export function resolveConflicts(scored: ScoredFact[], currentSessionId?: string): ResolveResult {
  const groups = new Map<string, ScoredFact[]>();
  for (const s of scored) {
    const key = conflictKey(s.fact);
    const arr = groups.get(key) ?? [];
    arr.push(s);
    groups.set(key, arr);
  }

  const resolved: ScoredFact[] = [];
  const conflicts: ConflictNote[] = [];

  for (const [key, arr] of groups) {
    if (arr.length === 1) {
      resolved.push(arr[0]!);
      continue;
    }
    const distinctObjects = new Set(arr.map((s) => objStr(s.fact)));
    if (distinctObjects.size === 1) {
      // same value asserted by several sources → keep the highest-precedence one
      const winner = byPrecedence(
        arr.map((s) => s.fact),
        currentSessionId,
      )[0]!;
      resolved.push(arr.find((s) => s.fact.fact_id === winner.fact_id) ?? arr[0]!);
      continue;
    }

    // genuine contradiction → precedence decides the winner
    const orderedFacts = byPrecedence(
      arr.map((s) => s.fact),
      currentSessionId,
    );
    const winnerFact = orderedFacts[0]!;
    const winner = arr.find((s) => s.fact.fact_id === winnerFact.fact_id)!;
    resolved.push(winner);

    const loser = orderedFacts[1]!;
    conflicts.push({
      conflict_id: conflictIdForKey(key),
      summary: `Conflicting ${conflictLabelForKey(key)}: ${quotedObj(winnerFact)} wins over ${quotedObj(loser)} (${winReason(winnerFact, loser, currentSessionId)}).`,
    });
  }

  return { resolved, conflicts };
}

export function conflictKey(f: Fact): string {
  return `${f.subject}::${f.predicate}`;
}

export function conflictIdForKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

export function conflictLabelForKey(key: string): string {
  return redactSecrets(key.replace("::", " "));
}

export function conflictDisplayObject(f: Fact): string {
  return displayObj(f);
}

function winReason(winner: Fact, loser: Fact, sessionId?: string): string {
  const rw = precedenceRank(winner, sessionId);
  const rl = precedenceRank(loser, sessionId);
  const label = (r: number): string =>
    [
      "safety",
      "current-session user instruction",
      "repo structured evidence",
      "workspace decision",
      "user static profile",
      "user dynamic profile",
      "older session memory",
      "agent inference",
      "repo prose",
    ][r] ?? "memory";
  return rw < rl ? `${label(rw)} > ${label(rl)}` : "higher precedence";
}

function objStr(f: Fact): string {
  return typeof f.object === "string" ? f.object : JSON.stringify(f.object);
}

function quotedObj(f: Fact): string {
  return JSON.stringify(displayObj(f));
}

function displayObj(f: Fact): string {
  const redacted = redactSecretValue(f.object);
  const value = typeof redacted === "string" ? redacted : JSON.stringify(redacted);
  return isRepoProse(f) ? asClaim(value) : value;
}

function isRepoProse(f: Fact): boolean {
  return f.trust_tier === "low" && f.source.asserted_by === "deterministic_parser";
}

// ---- Optimistic concurrency for parallel-session durable writes (SPEC §14) ----

export type ConcurrencyOutcome =
  | { kind: "apply" } // no conflict — safe to write
  | { kind: "partition"; reason: string } // branch-disjoint → both coexist
  | { kind: "invalidate"; reason: string } // deterministic winner → supersede base
  | { kind: "disputed"; reason: string }; // ambiguous → mark disputed, never silent LWW

export interface WriteIntent {
  // The fact_id the writer last saw for this (subject,predicate) when it began.
  // If it no longer matches the stored current fact, a concurrent write landed.
  base_seen_fact_id?: string;
  base_git_head?: string;
  branch?: string;
  fact: Fact;
}

// Decide how to reconcile a durable write against the current stored fact.
// NEVER silent last-writer-wins (D: §14). When the writer's base is stale (a
// concurrent write changed the value), we partition/invalidate/dispute instead.
export function reconcileWrite(
  intent: WriteIntent,
  current: Fact | null,
  isAncestor: (a: string, b: string) => boolean,
): ConcurrencyOutcome {
  // No current fact, or the writer saw the current version → straightforward apply.
  if (!current) return { kind: "apply" };
  if (intent.base_seen_fact_id && intent.base_seen_fact_id === current.fact_id) {
    return { kind: "apply" };
  }

  // Same value → idempotent apply (no real conflict).
  if (objStr(intent.fact) === objStr(current)) return { kind: "apply" };

  // Branch-disjoint writes coexist (partition by branch).
  const ib = intent.branch ?? intent.fact.git?.branch;
  const cb = current.git?.branch;
  if (ib && cb && ib !== cb) {
    return { kind: "partition", reason: `branch-disjoint (${ib} vs ${cb})` };
  }

  // Deterministic winner: an incoming high-trust structured fact whose base is
  // an ancestor of the current head supersedes a lower-trust current value.
  if (
    intent.fact.trust_tier === "high" &&
    current.trust_tier === "low" &&
    intent.base_git_head &&
    current.git?.valid_from_commit &&
    isAncestor(current.git.valid_from_commit, intent.base_git_head)
  ) {
    return { kind: "invalidate", reason: "high-trust structured evidence supersedes prose" };
  }

  // Otherwise: ambiguous contradiction → dispute (surface, never silently pick).
  return { kind: "disputed", reason: "concurrent contradictory writes; needs resolution" };
}
