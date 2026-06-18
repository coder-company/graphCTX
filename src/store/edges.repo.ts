import { type Clock, systemClock } from "../core/clock.js";
import { edgeId } from "../core/ids.js";
import type { DB } from "./db.js";

// Edge kinds used by the M1 invalidation engine (SPEC §11).
export type EdgeKind =
  | "SUPERSEDES"
  | "INVALIDATES"
  | "CONFLICTS_WITH"
  | "OVERRIDES"
  | "SUPPORTED_BY"
  | "SUPERSEDED_BY";

export interface Edge {
  edge_id: string;
  from_id: string;
  edge_kind: EdgeKind;
  to_id: string;
  source_fact_id?: string;
  created_at: string;
}

interface EdgeRow {
  edge_id: string;
  from_id: string;
  edge_kind: string;
  to_id: string;
  scope_json: string | null;
  source_fact_id: string | null;
  created_at: string;
}

export class EdgesRepo {
  private readonly db: DB;
  private readonly clock: Clock;

  constructor(db: DB, clock: Clock = systemClock) {
    this.db = db;
    this.clock = clock;
  }

  add(fromId: string, kind: EdgeKind, toId: string, sourceFactId?: string): Edge {
    const id = edgeId();
    const now = this.clock.iso();
    this.db
      .prepare(
        `INSERT INTO edges (edge_id, from_id, edge_kind, to_id, scope_json, source_fact_id, created_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?)`,
      )
      .run(id, fromId, kind, toId, sourceFactId ?? null, now);
    return {
      edge_id: id,
      from_id: fromId,
      edge_kind: kind,
      to_id: toId,
      source_fact_id: sourceFactId,
      created_at: now,
    };
  }

  // Edges leaving a node (optionally filtered by kind).
  from(fromId: string, kind?: EdgeKind): Edge[] {
    const rows = (
      kind
        ? this.db
            .prepare("SELECT * FROM edges WHERE from_id = ? AND edge_kind = ? ORDER BY created_at")
            .all(fromId, kind)
        : this.db.prepare("SELECT * FROM edges WHERE from_id = ? ORDER BY created_at").all(fromId)
    ) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  // Edges arriving at a node (optionally filtered by kind).
  to(toId: string, kind?: EdgeKind): Edge[] {
    const rows = (
      kind
        ? this.db
            .prepare("SELECT * FROM edges WHERE to_id = ? AND edge_kind = ? ORDER BY created_at")
            .all(toId, kind)
        : this.db.prepare("SELECT * FROM edges WHERE to_id = ? ORDER BY created_at").all(toId)
    ) as EdgeRow[];
    return rows.map(rowToEdge);
  }

  // All edges touching a node (either direction) — used by why().
  touching(factId: string): Edge[] {
    const rows = this.db
      .prepare("SELECT * FROM edges WHERE from_id = ? OR to_id = ? ORDER BY created_at")
      .all(factId, factId) as EdgeRow[];
    return rows.map(rowToEdge);
  }
}

function rowToEdge(r: EdgeRow): Edge {
  return {
    edge_id: r.edge_id,
    from_id: r.from_id,
    edge_kind: r.edge_kind as EdgeKind,
    to_id: r.to_id,
    source_fact_id: r.source_fact_id ?? undefined,
    created_at: r.created_at,
  };
}
