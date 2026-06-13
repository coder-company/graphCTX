import { type Clock, systemClock } from "../core/clock.js";
import { promotionId } from "../core/ids.js";
import type { DB } from "./db.js";

export interface PromotionRecord {
  promotion_id: string;
  fact_id: string;
  from_state: string;
  to_state: string;
  decision: string; // promote | candidate | reject
  gate?: string;
  reason?: string;
  created_at: string;
}

interface PromotionRow {
  promotion_id: string;
  fact_id: string;
  from_state: string;
  to_state: string;
  decision: string;
  gate: string | null;
  reason: string | null;
  created_at: string;
}

export class PromotionsRepo {
  private readonly db: DB;
  private readonly clock: Clock;

  constructor(db: DB, clock: Clock = systemClock) {
    this.db = db;
    this.clock = clock;
  }

  record(input: Omit<PromotionRecord, "promotion_id" | "created_at">): PromotionRecord {
    const id = promotionId();
    const now = this.clock.iso();
    this.db
      .prepare(
        `INSERT INTO promotions (promotion_id, fact_id, from_state, to_state, decision, gate, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.fact_id,
        input.from_state,
        input.to_state,
        input.decision,
        input.gate ?? null,
        input.reason ?? null,
        now,
      );
    return { promotion_id: id, created_at: now, ...input };
  }

  forFact(factId: string): PromotionRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM promotions WHERE fact_id = ? ORDER BY created_at")
      .all(factId) as PromotionRow[];
    return rows.map(rowTo);
  }
}

function rowTo(r: PromotionRow): PromotionRecord {
  return {
    promotion_id: r.promotion_id,
    fact_id: r.fact_id,
    from_state: r.from_state,
    to_state: r.to_state,
    decision: r.decision,
    gate: r.gate ?? undefined,
    reason: r.reason ?? undefined,
    created_at: r.created_at,
  };
}
