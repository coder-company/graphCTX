import { type Clock, systemClock } from "../core/clock.js";
import { procedureId } from "../core/ids.js";
import type { DB } from "./db.js";

export interface ProcedureStep {
  description: string;
  command?: string | null;
}

export interface ProcedureVerifier {
  command?: string | null;
  expected_exit_code?: number;
}

// Descriptive-only procedure (D10 — NO safe_to_autorun, ever).
export interface Procedure {
  procedure_id: string;
  fact_id: string;
  name: string;
  steps: ProcedureStep[];
  verifier?: ProcedureVerifier;
  success_count: number;
  failure_count: number;
  last_success_commit?: string;
  last_success_at?: string;
}

export interface NewProcedure {
  fact_id: string;
  name: string;
  steps: ProcedureStep[];
  verifier?: ProcedureVerifier;
}

interface ProcedureRow {
  procedure_id: string;
  fact_id: string;
  name: string;
  procedure_json: string;
  success_count: number;
  failure_count: number;
  last_success_commit: string | null;
  last_success_at: string | null;
}

export class ProceduresRepo {
  private readonly db: DB;
  private readonly clock: Clock;

  constructor(db: DB, clock: Clock = systemClock) {
    this.db = db;
    this.clock = clock;
  }

  insert(input: NewProcedure): Procedure {
    const id = procedureId();
    this.db
      .prepare(
        `INSERT INTO procedures
          (procedure_id, fact_id, name, procedure_json, success_count, failure_count)
         VALUES (?, ?, ?, ?, 0, 0)`,
      )
      .run(
        id,
        input.fact_id,
        input.name,
        JSON.stringify({ steps: input.steps, verifier: input.verifier }),
      );
    return {
      procedure_id: id,
      fact_id: input.fact_id,
      name: input.name,
      steps: input.steps,
      verifier: input.verifier,
      success_count: 0,
      failure_count: 0,
    };
  }

  byFact(factId: string): Procedure | null {
    const row = this.db.prepare("SELECT * FROM procedures WHERE fact_id = ?").get(factId) as
      | ProcedureRow
      | undefined;
    return row ? tryHydrate(row) : null;
  }

  byName(name: string): Procedure[] {
    const rows = this.db
      .prepare("SELECT * FROM procedures WHERE name = ?")
      .all(name) as ProcedureRow[];
    return rows.map(tryHydrate).filter((p): p is Procedure => !!p);
  }

  all(): Procedure[] {
    const rows = this.db.prepare("SELECT * FROM procedures").all() as ProcedureRow[];
    return rows.map(tryHydrate).filter((p): p is Procedure => !!p);
  }

  recordSuccess(procedureId: string, commit?: string): void {
    this.db
      .prepare(
        `UPDATE procedures SET success_count = success_count + 1,
           last_success_commit = ?, last_success_at = ? WHERE procedure_id = ?`,
      )
      .run(commit ?? null, this.clock.iso(), procedureId);
  }

  recordFailure(procedureId: string): void {
    this.db
      .prepare("UPDATE procedures SET failure_count = failure_count + 1 WHERE procedure_id = ?")
      .run(procedureId);
  }
}

function hydrate(row: ProcedureRow): Procedure {
  const body = JSON.parse(row.procedure_json) as {
    steps: ProcedureStep[];
    verifier?: ProcedureVerifier;
  };
  return {
    procedure_id: row.procedure_id,
    fact_id: row.fact_id,
    name: row.name,
    steps: body.steps ?? [],
    verifier: body.verifier,
    success_count: row.success_count,
    failure_count: row.failure_count,
    last_success_commit: row.last_success_commit ?? undefined,
    last_success_at: row.last_success_at ?? undefined,
  };
}

function tryHydrate(row: ProcedureRow): Procedure | null {
  try {
    return hydrate(row);
  } catch {
    return null;
  }
}
