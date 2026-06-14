import type { Fact } from "../core/types.js";

// Precedence ordering (SPEC §14, GAMEPLAN §8.2 corrected). LOWER rank = HIGHER
// precedence (wins). The key correction: repo PROSE (low-trust) sits BELOW the
// user profile; only repo STRUCTURED evidence (high-trust) ranks high.
//
//  0 safety / permissions
//  1 current-session explicit user instruction
//  2 repo STRUCTURED evidence at HEAD (config/lockfile/CI) — high trust only
//  3 workspace durable decision
//  4 user static profile
//  5 user dynamic profile
//  6 older session memory
//  7 agent inference
//  8 repo PROSE (AGENTS.md/README/comments) — low trust, below user profile
export function precedenceRank(f: Fact, currentSessionId?: string): number {
  // 0 — safety/permissions tag always wins.
  if (f.tags.includes("safety") || f.tags.includes("permissions")) return 0;

  const isUser = f.source.asserted_by === "user";
  const isCurrentSession = !!f.scope.session_id && f.scope.session_id === currentSessionId;

  // 1 — explicit user instruction in the current session.
  if (isUser && isCurrentSession) return 1;

  // 2 — repo structured (high-trust deterministic) evidence.
  if (f.trust_tier === "high" && f.source.asserted_by === "deterministic_parser") return 2;

  // 8 — repo prose (low-trust). Must rank BELOW user profile (D14).
  const isProse = f.trust_tier === "low" && f.source.asserted_by === "deterministic_parser";
  if (isProse) return 8;

  // 3 — workspace durable decision.
  if (f.promotion_state === "workspace_active" && !isProse) return 3;

  // 4/5 — user profile static/dynamic.
  if (f.promotion_state.startsWith("user_static")) return 4;
  if (f.promotion_state.startsWith("user_dynamic")) return 5;

  // 7 — agent inference.
  if (f.source.asserted_by === "agent") return 7;

  // 6 — older session memory / everything else.
  return 6;
}

// Order facts by precedence (winner first), deterministic content-key tiebreak.
export function byPrecedence(facts: Fact[], currentSessionId?: string): Fact[] {
  return [...facts].sort((a, b) => {
    const ra = precedenceRank(a, currentSessionId);
    const rb = precedenceRank(b, currentSessionId);
    if (ra !== rb) return ra - rb;
    const ka = contentKey(a);
    const kb = contentKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

function contentKey(f: Fact): string {
  const obj = typeof f.object === "string" ? f.object : JSON.stringify(f.object);
  return `${f.subject}::${f.predicate}::${obj}`;
}
