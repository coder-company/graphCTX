import type { ScoredFact } from "../core/types.js";
import type { DB } from "../store/db.js";

// Per-session anti-repetition ledger (SPEC §15). M2: DB-backed so idempotency
// holds ACROSS PROCESSES and CHANNELS — a fact pushed by a short-lived hook
// process must not be re-pushed by the long-lived MCP rider in the same session
// within the TTL. Falls back to pure in-memory when no DB is supplied (tests /
// degraded mode, I9).
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h: a fact stays "recently injected" for an hour

export class Ledger {
  private readonly mem = new Map<string, Map<string, number>>();
  private readonly db: DB | null;
  private readonly ttlMs: number;

  constructor(db: DB | null = null, ttlMs: number = DEFAULT_TTL_MS) {
    this.db = db;
    this.ttlMs = ttlMs;
  }

  recentlyInjected(sessionId: string, factId: string): boolean {
    const at = this.lookup(sessionId, factId);
    if (at === undefined) return false;
    return Date.now() - at < this.ttlMs;
  }

  removeRecentlyInjected(facts: ScoredFact[], sessionId?: string): ScoredFact[] {
    if (!sessionId) return facts;
    return facts.filter(
      // Open loops are exempt: an unfinished thread must keep resurfacing across
      // compactions until it is resolved (M1 §7).
      (f) => f.fact.fact_kind === "open_loop" || !this.recentlyInjected(sessionId, f.fact.fact_id),
    );
  }

  record(sessionId: string | undefined, facts: ScoredFact[], eventType?: string): void {
    if (!sessionId) return;
    const now = Date.now();
    const set = this.mem.get(sessionId) ?? new Map<string, number>();
    for (const f of facts) {
      if (f.fact.fact_kind === "open_loop") continue; // never suppress open loops
      set.set(f.fact.fact_id, now);
      this.persist(sessionId, f.fact.fact_id, eventType, now);
    }
    this.mem.set(sessionId, set);
  }

  private lookup(sessionId: string, factId: string): number | undefined {
    const inMem = this.mem.get(sessionId)?.get(factId);
    if (inMem !== undefined) return inMem;
    if (!this.db) return undefined;
    try {
      const row = this.db
        .prepare("SELECT injected_at FROM inject_ledger WHERE session_id = ? AND fact_id = ?")
        .get(sessionId, factId) as { injected_at: string } | undefined;
      if (!row) return undefined;
      const at = Date.parse(row.injected_at);
      return Number.isFinite(at) ? at : undefined;
    } catch {
      return undefined; // ledger lookups must never break the inject path (I9)
    }
  }

  private persist(sessionId: string, factId: string, eventType: string | undefined, now: number) {
    if (!this.db) return;
    try {
      this.db
        .prepare(
          `INSERT INTO inject_ledger(session_id, fact_id, event_type, injected_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(session_id, fact_id) DO UPDATE SET
             injected_at = excluded.injected_at, event_type = excluded.event_type`,
        )
        .run(sessionId, factId, eventType ?? null, new Date(now).toISOString());
    } catch {
      // best-effort: in-memory still enforces within-process idempotency (I9)
    }
  }
}
