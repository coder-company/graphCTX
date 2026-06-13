import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Fact } from "../core/types.js";

// The six relations an incoming fact can have to an existing one (SPEC §11).
export type Relation = "same" | "refines" | "invalidates" | "conflicts" | "coexists" | "unrelated";

export interface RelationVerdict {
  relation: Relation;
  reason: string;
  // True when a deterministic rule decided this (no LLM needed).
  deterministic: boolean;
}

export interface RelationContext {
  workspaceDir?: string;
  currentBranch?: string;
}

function objStr(o: unknown): string {
  return typeof o === "string" ? o : JSON.stringify(o);
}

// Deterministic-first classifier (SPEC §11). Runs BEFORE any LLM. Returns a
// verdict with deterministic=false ("unrelated") only when no rule applies —
// that is the signal for the caller to optionally consult the LLM fallback.
export function classifyRelation(
  incoming: Fact,
  existing: Fact,
  ctx: RelationContext = {},
): RelationVerdict {
  const samePredicate =
    incoming.subject === existing.subject && incoming.predicate === existing.predicate;

  // Different subject/predicate entirely → unrelated (deterministic).
  if (!samePredicate) {
    return { relation: "unrelated", reason: "different subject/predicate", deterministic: true };
  }

  // Identical assertion → same (merge evidence).
  if (objStr(incoming.object) === objStr(existing.object)) {
    return { relation: "same", reason: "identical subject+predicate+object", deterministic: true };
  }

  // Repo-scope vs user-scope on the same s/p → coexists with OVERRIDES.
  const incomingRepo = !!incoming.scope.workspace_id && !isUserScoped(incoming);
  const existingUser = isUserScoped(existing);
  if (incomingRepo && existingUser) {
    return {
      relation: "coexists",
      reason: "repo-scope overrides user-scope (different scope levels)",
      deterministic: true,
    };
  }

  // Branch-disjoint facts coexist (each true on its own branch).
  const ib = incoming.git?.branch;
  const eb = existing.git?.branch;
  if (ib && eb && ib !== eb) {
    return {
      relation: "coexists",
      reason: `branch-disjoint (${eb} vs ${ib})`,
      deterministic: true,
    };
  }

  // Git proves the existing fact's target file/script is gone → invalidates.
  if (ctx.workspaceDir && targetRemoved(existing, ctx.workspaceDir)) {
    return {
      relation: "invalidates",
      reason: "git/fs proves existing target path no longer exists",
      deterministic: true,
    };
  }

  // Same scope + same subject/predicate + different object, from a trusted
  // structured source → the newer assertion refines (supersedes) the older.
  const bothSameScope = sameScopeLevel(incoming, existing);
  if (bothSameScope && incoming.trust_tier === "high" && incoming.source.asserted_by !== "agent") {
    return {
      relation: "refines",
      reason: "same scope, high-trust newer value for same subject/predicate",
      deterministic: true,
    };
  }

  // Same scope, different object, but not clearly a refinement (e.g. one or both
  // low-trust) → a genuine conflict to mark disputed (no silent winner).
  if (bothSameScope) {
    return {
      relation: "conflicts",
      reason: "same scope, contradictory values, no trusted winner",
      deterministic: true,
    };
  }

  // No deterministic rule fired — eligible for LLM fallback.
  return { relation: "unrelated", reason: "no deterministic rule applied", deterministic: false };
}

function isUserScoped(f: Fact): boolean {
  return f.promotion_state.startsWith("user_") || (!f.scope.workspace_id && !f.scope.session_id);
}

function sameScopeLevel(a: Fact, b: Fact): boolean {
  const lvl = (f: Fact): string => {
    if (isUserScoped(f)) return "user";
    if (f.scope.workspace_id) return `ws:${f.scope.workspace_id}`;
    if (f.scope.session_id) return `sess:${f.scope.session_id}`;
    return "unknown";
  };
  return lvl(a) === lvl(b);
}

// Does the existing fact reference a concrete path/script that no longer exists?
function targetRemoved(existing: Fact, workspaceDir: string): boolean {
  const paths: string[] = [];
  if (existing.predicate === "do_not_edit" && typeof existing.subject === "string") {
    paths.push(existing.subject);
  }
  for (const g of existing.git?.path_globs ?? []) {
    if (!g.includes("*")) paths.push(g);
  }
  if (paths.length === 0) return false;
  return paths.every((p) => !existsSync(join(workspaceDir, p)));
}
