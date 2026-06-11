// Read model for the TUI: pulls live stats + fact views from the Runtime.

import type { Fact } from "../core/types.js";
import type { Runtime } from "../runtime.js";

export interface MemoryStats {
  total: number;
  active: number;
  candidate: number;
  expired: number;
  superseded: number;
  disputed: number;
  openLoops: number;
  procedures: number;
  secrets: number;
  byScope: { session: number; workspace: number; user: number };
  byKind: Record<string, number>;
  byTrust: { high: number; low: number };
}

export function memoryStats(rt: Runtime): MemoryStats {
  const all = rt.facts.all({ user_id: rt.userId, workspace_id: rt.workspaceId });
  const byKind: Record<string, number> = {};
  const s: MemoryStats = {
    total: all.length,
    active: 0,
    candidate: 0,
    expired: 0,
    superseded: 0,
    disputed: 0,
    openLoops: 0,
    procedures: 0,
    secrets: 0,
    byScope: { session: 0, workspace: 0, user: 0 },
    byKind,
    byTrust: { high: 0, low: 0 },
  };
  for (const f of all) {
    if (f.status === "active") s.active++;
    if (f.status === "candidate") s.candidate++;
    if (f.status === "expired") s.expired++;
    if (f.status === "superseded") s.superseded++;
    if (f.status === "disputed") s.disputed++;
    if (f.fact_kind === "open_loop" && f.status === "active") s.openLoops++;
    if (f.fact_kind === "procedural") s.procedures++;
    if (f.sensitivity === "secret" || f.sensitivity === "credential") s.secrets++;
    byKind[f.fact_kind] = (byKind[f.fact_kind] ?? 0) + 1;
    if (f.trust_tier === "high") s.byTrust.high++;
    else s.byTrust.low++;
    if (f.promotion_state.startsWith("user_")) s.byScope.user++;
    else if (f.promotion_state.startsWith("workspace_")) s.byScope.workspace++;
    else s.byScope.session++;
  }
  return s;
}

export interface FactView {
  fact: Fact;
  id8: string;
  kind: string;
  scope: string;
  status: string;
  trust: string;
  text: string;
}

export function factViews(rt: Runtime, filter?: (f: Fact) => boolean): FactView[] {
  const all = rt.facts.all({ user_id: rt.userId, workspace_id: rt.workspaceId });
  const facts = filter ? all.filter(filter) : all;
  return facts.map((f) => ({
    fact: f,
    id8: f.fact_id.slice(-8),
    kind: f.fact_kind,
    scope: f.promotion_state.startsWith("user_")
      ? "user"
      : f.promotion_state.startsWith("workspace_")
        ? "workspace"
        : "session",
    status: f.status,
    trust: f.trust_tier,
    text: factText(f),
  }));
}

export function factText(f: Fact): string {
  const obj = typeof f.object === "string" ? f.object : JSON.stringify(f.object);
  if (f.predicate === "open_loop") return obj;
  if (f.subject === "repo" || f.subject === "session" || f.subject === "workflow") {
    return `${f.predicate.replace(/_/g, " ")}: ${obj}`;
  }
  return `${f.subject} ${f.predicate.replace(/_/g, " ")} ${obj}`;
}
