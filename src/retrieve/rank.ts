import type { Fact, ScoredFact } from "../core/types.js";

// Stable content key for deterministic tiebreaking. fact_id is a random ULID and
// must NOT be used to break ties (it varies run-to-run).
function contentKey(f: Fact): string {
  const obj = typeof f.object === "string" ? f.object : JSON.stringify(f.object);
  return `${f.subject}::${f.predicate}::${obj}`;
}

// Deterministic fusion (SPEC §13, D6 — no learned weights). Combine per-fact
// bm25 + entity signals scaled by scope weight; dedupe by fact_id keeping max.
export function fuse(scored: ScoredFact[]): ScoredFact[] {
  const byId = new Map<string, ScoredFact>();
  for (const s of scored) {
    const existing = byId.get(s.fact.fact_id);
    if (!existing || s.score > existing.score) byId.set(s.fact.fact_id, s);
  }
  // Stable, deterministic ordering: score desc, then content-key asc as a
  // tiebreaker (KNN/vector ties must not produce run-to-run variation).
  return [...byId.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ka = contentKey(a.fact);
    const kb = contentKey(b.fact);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}
