import type { Episode, Fact, GitAnchor } from "../core/types.js";
import { redactSecretValue, redactSecrets } from "../security/secrets.js";
import type { Edge, EdgesRepo } from "../store/edges.repo.js";
import type { EpisodesRepo } from "../store/episodes.repo.js";
import type { FactsRepo } from "../store/facts.repo.js";
import type { PromotionRecord, PromotionsRepo } from "../store/promotions.repo.js";

// The complete provenance chain for a fact (SPEC §11/§12, M1 §5). Answers
// "why is this in my memory, and why should I trust it?".
export interface WhyReport {
  fact: Fact;
  asserted_by: string;
  raw_quote?: string;
  evidence: Episode[]; // source events that exist in the store
  missing_evidence_ids: string[]; // cited event ids no longer present
  git_anchor?: GitAnchor;
  promotions: PromotionRecord[]; // audit trail incl. which gate fired
  edges: Edge[]; // supersedes / invalidates / conflicts / overrides
  complete: boolean; // chain is fully resolvable
}

export interface WhyDeps {
  facts: FactsRepo;
  episodes: EpisodesRepo;
  edges: EdgesRepo;
  promotions: PromotionsRepo;
}

export function why(factId: string, deps: WhyDeps): WhyReport | null {
  const fact = deps.facts.get(factId);
  if (!fact) return null;

  const evidence: Episode[] = [];
  const missing: string[] = [];
  for (const id of fact.source.event_ids) {
    const ep = deps.episodes.byId(id);
    if (ep) evidence.push(ep);
    else missing.push(id);
  }

  const promotions = deps.promotions.forFact(factId);
  const edges = deps.edges.touching(factId);

  // A chain is complete when every cited evidence id resolves (or none was
  // cited — deterministic facts legitimately carry no event ids).
  const complete = missing.length === 0;

  return {
    fact,
    asserted_by: fact.source.asserted_by,
    raw_quote: fact.source.raw_quote,
    evidence,
    missing_evidence_ids: missing,
    git_anchor: fact.git,
    promotions,
    edges,
    complete,
  };
}

export function formatWhy(r: WhyReport): string {
  const redacted = redactWhyReport(r);
  const lines: string[] = [];
  const obj =
    typeof redacted.fact.object === "string"
      ? redacted.fact.object
      : JSON.stringify(redacted.fact.object);
  lines.push(
    `why [mem:${redacted.fact.fact_id.slice(-8)}] — ${redacted.fact.subject} ${redacted.fact.predicate}: ${obj}`,
  );
  lines.push("=".repeat(72));
  lines.push(`  kind:          ${redacted.fact.fact_kind} / ${redacted.fact.temporal_kind}`);
  lines.push(`  status:        ${redacted.fact.status}  (${redacted.fact.promotion_state})`);
  lines.push(
    `  observed:      ${redacted.fact.time.t_observed}  recorded=${redacted.fact.time.t_recorded}`,
  );
  if (redacted.fact.time.t_expired || redacted.fact.time.invalidated_by) {
    lines.push(
      `  expired:       ${redacted.fact.time.t_expired ?? "-"}  invalidated_by=${short(redacted.fact.time.invalidated_by)}`,
    );
  }
  lines.push(
    `  trust:         ${redacted.fact.trust_tier}  sensitivity=${redacted.fact.sensitivity}`,
  );
  lines.push(`  asserted by:   ${redacted.asserted_by}`);
  if (redacted.raw_quote) lines.push(`  raw quote:     "${redacted.raw_quote}"`);
  if (redacted.git_anchor) {
    const g = redacted.git_anchor;
    lines.push(
      `  git anchor:    branch=${g.branch ?? "-"} from=${short(g.valid_from_commit)} introduced=${short(g.introduced_by_commit)}${g.valid_until_commit ? ` until=${short(g.valid_until_commit)}` : ""}`,
    );
  }
  lines.push(
    `  evidence:      ${redacted.evidence.length} event(s)${redacted.missing_evidence_ids.length ? `, ${redacted.missing_evidence_ids.length} missing` : ""}`,
  );
  for (const e of redacted.evidence)
    lines.push(`     - ${e.event_type} @ ${e.created_at} [${e.event_id.slice(-8)}]`);
  if (redacted.promotions.length) {
    lines.push("  promotions:");
    for (const p of redacted.promotions) {
      lines.push(
        `     - ${p.from_state} → ${p.to_state}  [${p.decision}] gate=${p.gate ?? "-"}  ${p.reason ?? ""}`,
      );
    }
  }
  if (redacted.edges.length) {
    lines.push("  edges:");
    for (const e of redacted.edges) {
      const dir =
        e.from_id === redacted.fact.fact_id ? `→ ${short(e.to_id)}` : `← ${short(e.from_id)}`;
      lines.push(`     - ${e.edge_kind} ${dir}`);
    }
  }
  lines.push("");
  lines.push(
    `  provenance chain: ${redacted.complete ? "✅ complete" : "⚠ incomplete (missing evidence)"}`,
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function redactWhyReport(r: WhyReport): WhyReport {
  return {
    ...r,
    raw_quote: r.raw_quote ? redactSecrets(r.raw_quote) : undefined,
    fact: {
      ...r.fact,
      object: redactSecretValue(r.fact.object),
      source: {
        ...r.fact.source,
        raw_quote: r.fact.source.raw_quote ? redactSecrets(r.fact.source.raw_quote) : undefined,
      },
    },
  };
}

function short(id?: string): string {
  if (!id) return "-";
  return id.length > 8 ? id.slice(0, 8) : id;
}
