import type { ScoredFact } from "../core/types.js";

// Deterministic fusion (SPEC §13, D6 — no learned weights). Combine per-fact
// bm25 + entity signals scaled by scope weight; dedupe by fact_id keeping max.
export function fuse(scored: ScoredFact[]): ScoredFact[] {
  const byId = new Map<string, ScoredFact>();
  for (const s of scored) {
    const existing = byId.get(s.fact.fact_id);
    if (!existing || s.score > existing.score) byId.set(s.fact.fact_id, s);
  }
  return [...byId.values()].sort((a, b) => b.score - a.score);
}
