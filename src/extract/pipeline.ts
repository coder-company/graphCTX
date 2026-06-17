import type { Fact, NewFact } from "../core/types.js";
import { containsSecret } from "../security/secrets.js";
import type { FactsRepo } from "../store/facts.repo.js";
import { agentFilesExtractor } from "./deterministic/agent-files.js";
import { ciExtractor } from "./deterministic/ci.js";
import { editorconfigExtractor } from "./deterministic/editorconfig.js";
import { generatedMarkersExtractor } from "./deterministic/generated-markers.js";
import { lockfileExtractor } from "./deterministic/lockfile.js";
import { packageScriptsExtractor } from "./deterministic/package-scripts.js";
import type { ExtractContext, Extractor } from "./deterministic/types.js";

export const DETERMINISTIC_EXTRACTORS: Extractor[] = [
  packageScriptsExtractor,
  editorconfigExtractor,
  lockfileExtractor,
  ciExtractor,
  generatedMarkersExtractor,
  agentFilesExtractor,
];

export interface ExtractResult {
  inserted: Fact[];
  skippedSecret: number;
  skippedDuplicate: number;
  expiredStale: number;
}

// Runs all deterministic extractors synchronously (SPEC §10.1, < 50ms target),
// scrubs secrets (I3), reconciles stale deterministic evidence, and upserts new
// facts. Idempotent on (subject,predicate,object).
export function runDeterministicExtraction(repo: FactsRepo, ctx: ExtractContext): ExtractResult {
  const candidates: NewFact[] = [];
  for (const ex of DETERMINISTIC_EXTRACTORS) {
    try {
      candidates.push(...ex.extract(ctx));
    } catch {
      // a broken extractor must not break the pipeline (I9)
    }
  }

  const inserted: Fact[] = [];
  let skippedSecret = 0;
  let skippedDuplicate = 0;
  const currentEvidenceKeys = new Set<string>();

  for (const f of candidates) {
    const objStr = typeof f.object === "string" ? f.object : JSON.stringify(f.object);
    if (containsSecret(`${f.predicate} ${objStr} ${f.source.raw_quote ?? ""}`)) {
      skippedSecret++;
      continue;
    }
    currentEvidenceKeys.add(evidenceKey(f, objStr));
    if (isDuplicate(repo, f, objStr)) {
      skippedDuplicate++;
      continue;
    }
    inserted.push(repo.insert(f));
  }

  const expiredStale = expireStaleDeterministicFacts(repo, ctx, currentEvidenceKeys);

  return { inserted, skippedSecret, skippedDuplicate, expiredStale };
}

function isDuplicate(repo: FactsRepo, f: NewFact, objStr: string): boolean {
  const existing = repo.bySubjectPredicate(f.subject, f.predicate, {
    user_id: f.scope.user_id,
    workspace_id: f.scope.workspace_id,
  });
  return existing.some((e) => {
    const eObj = typeof e.object === "string" ? e.object : JSON.stringify(e.object);
    return eObj === objStr && e.status !== "expired";
  });
}

function expireStaleDeterministicFacts(
  repo: FactsRepo,
  ctx: ExtractContext,
  currentEvidenceKeys: Set<string>,
): number {
  let expired = 0;
  for (const existing of repo.activeAsOf({
    user_id: ctx.scope.user_id,
    workspace_id: ctx.scope.workspace_id,
  })) {
    if (!isManagedDeterministicFact(existing)) continue;
    if (currentEvidenceKeys.has(evidenceKey(existing))) continue;
    repo.expireDueToMissingEvidence(existing.fact_id, ctx.head);
    expired++;
  }
  return expired;
}

function isManagedDeterministicFact(fact: Fact): boolean {
  return (
    fact.source.asserted_by === "deterministic_parser" &&
    fact.trust_tier === "high" &&
    fact.promotion_state === "workspace_active"
  );
}

function evidenceKey(fact: Pick<Fact, "subject" | "predicate" | "object">): string;
function evidenceKey(fact: NewFact, objectString?: string): string;
function evidenceKey(
  fact: Pick<Fact, "subject" | "predicate" | "object"> | NewFact,
  objectString?: string,
): string {
  const obj =
    objectString ?? (typeof fact.object === "string" ? fact.object : JSON.stringify(fact.object));
  return `${fact.subject}\u0000${fact.predicate}\u0000${obj}`;
}
