import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Episode, Fact } from "../core/types.js";
import type { ChatMessage, LlmProvider } from "../llm/provider.js";
import { parseJsonResponse } from "../llm/provider.js";
import type { Relation } from "./relation.js";

const here = dirname(fileURLToPath(import.meta.url));

// The LLM invalidation fallback (SPEC §11). It is consulted ONLY when the
// deterministic classifier abstains. Two hard rules, enforced by the caller
// (invalidator.ts), not merely by the prompt:
//   1. It MUST cite evidence IDs (event_ids) that actually exist.
//   2. It MAY NOT invalidate from world knowledge — every `invalidates`/`conflicts`
//      verdict must be backed by cited evidence present in the store.
export interface LlmRelationVerdict {
  relation: Relation;
  cited_evidence_ids: string[];
  rationale: string;
}

export interface LlmInvalidationAgent {
  classify(incoming: Fact, existing: Fact): Promise<LlmRelationVerdict | null>;
}

// M1 ships NO networked LLM (that is M3). This null agent always abstains, so
// the engine relies entirely on deterministic rules unless a real agent is
// injected (e.g. in tests or a future milestone). Keeping the seam here lets us
// unit-test the cited-evidence post-check without a network.
export const nullLlmAgent: LlmInvalidationAgent = {
  async classify() {
    return null;
  },
};

const RELATIONS = ["same", "refines", "invalidates", "conflicts", "coexists", "unrelated"] as const;
const verdictSchema = z.object({
  relation: z.enum(RELATIONS),
  cited_evidence_ids: z.array(z.string()).default([]),
  rationale: z.string().default(""),
});

export interface ProviderAgentDeps {
  provider: LlmProvider;
  // Episodes that may be cited as evidence; the agent surfaces them to the model
  // and the invalidator re-checks that every cited id actually exists (no
  // world-knowledge invalidation).
  evidence?: Episode[];
  promptVersion?: string;
}

// Real provider-backed invalidation agent (SPEC §11, M3). ASYNC + FAIL-SOFT: a
// missing key/provider or any error abstains (returns null) so the engine falls
// back to deterministic rules. The two HARD post-checks (cite >=1 evidence id;
// every id must exist) are enforced by the invalidator, not just the prompt.
export function createLlmInvalidationAgent(deps: ProviderAgentDeps): LlmInvalidationAgent {
  if (!deps.provider.available) return nullLlmAgent;
  return {
    async classify(incoming: Fact, existing: Fact): Promise<LlmRelationVerdict | null> {
      try {
        const prompt = loadPrompt(deps.promptVersion ?? "invalidation.v1.md");
        const messages: ChatMessage[] = [
          { role: "system", content: prompt },
          { role: "user", content: renderContext(incoming, existing, deps.evidence ?? []) },
        ];
        const { text } = await deps.provider.chat({ messages, json: true, temperature: 0 });
        const parsed = parseJsonResponse<unknown>(text);
        if (!parsed) return null;
        const v = verdictSchema.safeParse(parsed);
        if (!v.success) return null;
        return {
          relation: v.data.relation as Relation,
          cited_evidence_ids: v.data.cited_evidence_ids,
          rationale: v.data.rationale,
        };
      } catch {
        return null;
      }
    },
  };
}

function renderContext(incoming: Fact, existing: Fact, evidence: Episode[]): string {
  const f = (x: Fact) =>
    `${x.subject} ${x.predicate} = ${typeof x.object === "string" ? x.object : JSON.stringify(x.object)}`;
  const ev = evidence
    .map((e) => `[${e.event_id}] ${e.event_type}: ${JSON.stringify(e.payload).slice(0, 400)}`)
    .join("\n");
  return [
    `INCOMING: ${f(incoming)}`,
    `EXISTING: ${f(existing)}`,
    "",
    "Available evidence (you may ONLY cite these ids):",
    ev || "(none)",
  ].join("\n");
}

function loadPrompt(file: string): string {
  // prompts live under extract/llm/prompts (shared prompt library).
  return readFileSync(join(here, "..", "extract", "llm", "prompts", file), "utf8");
}
