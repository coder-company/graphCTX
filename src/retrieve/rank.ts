import type { Fact, ScoredFact } from "../core/types.js";

// Stable content key for deterministic tiebreaking. fact_id is a random ULID and
// must NOT be used to break ties (it varies run-to-run). Exported so the
// retriever can break per-retriever RANK ties identically (RRF determinism).
export function contentKey(f: Fact): string {
  const obj = typeof f.object === "string" ? f.object : JSON.stringify(f.object);
  return `${f.subject}::${f.predicate}::${obj}`;
}

// Recency decay (M2, steal S5): a fact's freshness gently boosts its rank. Half
// life ~30 days; bounded to [0.7, 1.0] so recency only breaks near-ties and
// never buries a strongly-relevant older fact.
const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
function recencyFactor(f: Fact, nowMs: number): number {
  const t = Date.parse(f.time?.t_recorded ?? f.time?.t_created ?? "");
  if (!Number.isFinite(t)) return 1;
  const ageMs = Math.max(0, nowMs - t);
  const decay = 0.5 ** (ageMs / RECENCY_HALF_LIFE_MS); // (0,1]
  return 0.7 + 0.3 * decay;
}

// Confidence factor: bounded to [0.75, 1.0] so low-confidence facts are nudged
// down without being excluded (exclusion is the gate's/promotion's job).
function confidenceFactor(f: Fact): number {
  const c = Number.isFinite(f.confidence) ? Math.min(1, Math.max(0, f.confidence)) : 0.5;
  return 0.75 + 0.25 * c;
}

// Deterministic fusion (SPEC §13, D6 — no learned weights). The base score
// already carries the fused bm25 + entity + semantic signals scaled by scope
// weight (retriever). Here we apply confidence + recency as gentle multipliers
// (steal S5) so fusion reranks on more than similarity, then dedupe by fact_id.
export function fuse(scored: ScoredFact[], nowMs: number = Date.now()): ScoredFact[] {
  const byId = new Map<string, ScoredFact>();
  for (const s of scored) {
    const weighted: ScoredFact = {
      ...s,
      score: s.score * confidenceFactor(s.fact) * recencyFactor(s.fact, nowMs),
      signals: {
        ...s.signals,
        confidence: s.fact.confidence,
        recency: recencyFactor(s.fact, nowMs),
      },
    };
    const existing = byId.get(s.fact.fact_id);
    if (!existing || weighted.score > existing.score) byId.set(s.fact.fact_id, weighted);
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
