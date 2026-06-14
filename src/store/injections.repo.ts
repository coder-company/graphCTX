import { type Clock, systemClock } from "../core/clock.js";
import { injectionId } from "../core/ids.js";
import type { DB } from "./db.js";

export interface NewInjection {
  session_id: string;
  event_type: string;
  selected_fact_ids: string[];
  rejected_fact_ids?: string[];
  token_count: number;
  predicted_utility?: number;
  git_head?: string;
}

export class InjectionsRepo {
  private readonly db: DB;
  private readonly clock: Clock;

  constructor(db: DB, clock: Clock = systemClock) {
    this.db = db;
    this.clock = clock;
  }

  log(input: NewInjection): string {
    const id = injectionId();
    this.db
      .prepare(
        `INSERT INTO injections (
          injection_id, session_id, event_type, selected_fact_ids_json,
          rejected_fact_ids_json, token_count, predicted_utility, git_head, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.session_id,
        input.event_type,
        JSON.stringify(input.selected_fact_ids),
        input.rejected_fact_ids ? JSON.stringify(input.rejected_fact_ids) : null,
        input.token_count,
        input.predicted_utility ?? null,
        input.git_head ?? null,
        this.clock.iso(),
      );
    return id;
  }
}
