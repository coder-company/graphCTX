import type { Fact } from "../core/types.js";

// Promotion engine — HARD BOOLEAN GATES, no weighted scoring (SPEC §12, D6).
// These are PURE functions over a fact + context; all side effects (state
// transitions, audit rows) live in probation.ts.

export type DecisionKind = "promote" | "candidate" | "reject";

export interface Decision {
  kind: DecisionKind;
  gate: string; // reason code identifying which rule fired
  reason: string;
}

const promote = (gate: string, reason: string): Decision => ({ kind: "promote", gate, reason });
const candidate = (gate: string, reason: string): Decision => ({ kind: "candidate", gate, reason });
const reject = (gate: string, reason: string): Decision => ({ kind: "reject", gate, reason });

export interface PromotionContext {
  // True if the fact currently has an unresolved CONFLICTS_WITH edge / disputed status.
  hasUnresolvedConflict: boolean;
  // Procedure success count (from the procedures table), if applicable.
  procSuccesses?: number;
  // Distinct sessions in which this failure/constraint was observed.
  sessionsObserved?: number;
  minProcedureSuccesses: number;
  minFailureRepeats: number;
}

const BAD_LIFECYCLE = new Set(["disputed", "expired", "rejected", "superseded"]);

function isSecret(f: Fact): boolean {
  return f.sensitivity === "secret" || f.sensitivity === "credential";
}

// A user-asserted fact that explicitly concerns the repo/project (vs personal).
function saysRepoScoped(f: Fact): boolean {
  const text =
    `${f.predicate} ${stringify(f.object)} ${f.source.raw_quote ?? ""} ${f.tags.join(" ")}`.toLowerCase();
  return (
    /\b(repo|project|this codebase|this repo|workspace|here)\b/.test(text) ||
    f.tags.includes("repo")
  );
}

function saysGlobal(f: Fact): boolean {
  const text =
    `${stringify(f.object)} ${f.source.raw_quote ?? ""} ${f.tags.join(" ")}`.toLowerCase();
  return /\b(always|globally|every (?:project|repo)|in general|by default everywhere)\b/.test(text);
}

function hasDeterministicRepoEvidence(f: Fact): boolean {
  return (
    f.source.asserted_by === "deterministic_parser" &&
    f.trust_tier === "high" &&
    !!f.scope.workspace_id
  );
}

function isRepoConvention(f: Fact): boolean {
  return f.source.asserted_by === "deterministic_parser" || f.trust_tier === "low";
}

// session_only → workspace_active|candidate (SPEC §12).
export function sessionToWorkspace(f: Fact, ctx: PromotionContext): Decision {
  if (isSecret(f)) return reject("secret", "secrets/credentials never promote (I3)");
  if (f.fact_kind === "task_state") return reject("session_local", "task_state is session-local");
  if (BAD_LIFECYCLE.has(f.status)) return reject("bad_lifecycle", `status=${f.status}`);
  if (ctx.hasUnresolvedConflict) return candidate("needs_resolution", "unresolved conflict");

  if (f.source.asserted_by === "user" && saysRepoScoped(f)) {
    return promote("user_explicit", "user explicitly stated a repo-scoped fact");
  }
  if (hasDeterministicRepoEvidence(f)) {
    return promote("config_evidence", "high-trust deterministic repo evidence");
  }
  if (f.fact_kind === "procedural" && (ctx.procSuccesses ?? 0) >= ctx.minProcedureSuccesses) {
    return promote("verified_procedure", `procedure succeeded >= ${ctx.minProcedureSuccesses}x`);
  }
  if (
    (f.fact_kind === "failure" || f.fact_kind === "constraint") &&
    (ctx.sessionsObserved ?? 0) >= ctx.minFailureRepeats
  ) {
    return promote("repeated", `observed across >= ${ctx.minFailureRepeats} sessions`);
  }
  return candidate("insufficient_evidence", "no promotion gate satisfied");
}

// workspace → user (SPEC §12). v1 is explicit-only — never infer.
export function workspaceToUser(f: Fact): Decision {
  if (isSecret(f)) return reject("secret", "secrets/credentials never promote (I3)");
  if (!["preference", "procedural", "constraint"].includes(f.fact_kind)) {
    return reject("not_profile_material", `fact_kind=${f.fact_kind} is not profile material`);
  }
  if (BAD_LIFECYCLE.has(f.status)) return reject("bad_lifecycle", `status=${f.status}`);

  if (f.source.asserted_by === "user" && saysGlobal(f)) {
    return promote(
      f.temporal_kind === "static" ? "user_static" : "user_dynamic",
      "user explicitly stated a global preference",
    );
  }
  if (isRepoConvention(f)) {
    return reject("repo_convention", "repo convention is not a user preference");
  }
  return candidate("explicit_only", "v1 promotes to user scope on explicit intent only");
}

function stringify(o: unknown): string {
  return typeof o === "string" ? o : JSON.stringify(o);
}
