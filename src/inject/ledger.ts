import type { ScoredFact } from "../core/types.js";

// Per-session anti-repetition ledger (SPEC §15). In-memory for M0 (one hook
// process is short-lived; persistence across processes is M2). Suppresses
// re-injecting a fact already pushed in this session within a TTL.
export class Ledger {
  private readonly seen = new Map<string, Set<string>>();

  recentlyInjected(sessionId: string, factId: string): boolean {
    return this.seen.get(sessionId)?.has(factId) ?? false;
  }

  removeRecentlyInjected(facts: ScoredFact[], sessionId?: string): ScoredFact[] {
    if (!sessionId) return facts;
    const set = this.seen.get(sessionId);
    if (!set) return facts;
    // Open loops are exempt from anti-repetition: an unfinished thread must keep
    // resurfacing across compactions until it is resolved (M1 §7).
    return facts.filter((f) => f.fact.fact_kind === "open_loop" || !set.has(f.fact.fact_id));
  }

  record(sessionId: string | undefined, facts: ScoredFact[]): void {
    if (!sessionId) return;
    const set = this.seen.get(sessionId) ?? new Set<string>();
    for (const f of facts) {
      if (f.fact.fact_kind !== "open_loop") set.add(f.fact.fact_id);
    }
    this.seen.set(sessionId, set);
  }
}
