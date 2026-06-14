import type { Fact } from "../core/types.js";

// Entity-overlap score: fraction of mentioned entities present in the fact text.
export function entityScore(fact: Fact, entities: string[]): number {
  if (entities.length === 0) return 0;
  const hay =
    `${fact.subject} ${fact.predicate} ${stringify(fact.object)} ${fact.tags.join(" ")}`.toLowerCase();
  let hits = 0;
  for (const e of entities) {
    if (e && hay.includes(e.toLowerCase())) hits++;
  }
  return hits / entities.length;
}

// Scope weight (SPEC §13).
export function scopeWeight(fact: Fact, sessionId?: string): number {
  if (fact.scope.session_id && fact.scope.session_id === sessionId) return 1.0;
  if (fact.scope.workspace_id) return 0.9;
  if (fact.promotion_state.startsWith("user_static")) return 0.55;
  if (fact.promotion_state.startsWith("user_dynamic")) return 0.4;
  return 0.5;
}

function stringify(o: unknown): string {
  return typeof o === "string" ? o : JSON.stringify(o);
}
