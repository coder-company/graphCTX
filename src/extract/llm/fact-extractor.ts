import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Episode, FactKind, NewFact, Scope } from "../../core/types.js";
import type { ChatMessage, LlmProvider } from "../../llm/provider.js";
import { parseJsonResponse } from "../../llm/provider.js";
import { containsSecret } from "../../security/secrets.js";

const here = dirname(fileURLToPath(import.meta.url));

const FACT_KINDS = [
  "semantic",
  "procedural",
  "preference",
  "decision",
  "constraint",
  "failure",
  "task_state",
  "open_loop",
] as const;

const llmFactSchema = z.object({
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.union([z.string(), z.number(), z.boolean()]),
  fact_kind: z.enum(FACT_KINDS),
  trust_tier: z.enum(["high", "low"]).default("low"),
  confidence: z.number().min(0).max(1).default(0.5),
  evidence_ids: z.array(z.string()).default([]),
  raw_quote: z.string().optional(),
});
const llmFactBatchSchema = z.object({ facts: z.array(llmFactSchema).default([]) });

export interface FactExtractDeps {
  provider: LlmProvider;
  scope: Scope;
  promptVersion?: string;
}

// LLM fact extraction (SPEC §10.2). ASYNC, off the hot path. Returns NewFact[]
// for the caller to invalidate + insert. Fail-soft: no provider / bad output →
// [] (deterministic-only mode). NEVER throws.
export async function extractFactsFromEpisodes(
  episodes: Episode[],
  deps: FactExtractDeps,
): Promise<NewFact[]> {
  if (!deps.provider.available || episodes.length === 0) return [];
  try {
    const prompt = loadPrompt(deps.promptVersion ?? "fact_extract.v1.md");
    const transcript = renderTranscript(episodes);
    const messages: ChatMessage[] = [
      { role: "system", content: prompt },
      { role: "user", content: transcript },
    ];
    const { text } = await deps.provider.chat({ messages, json: true, temperature: 0 });
    const parsed = parseJsonResponse<unknown>(text);
    if (!parsed) return [];
    const batch = llmFactBatchSchema.safeParse(parsed);
    if (!batch.success) return [];

    const validEventIds = new Set(episodes.map((e) => e.event_id));
    const out: NewFact[] = [];
    for (const f of batch.data.facts) {
      const objStr = typeof f.object === "string" ? f.object : JSON.stringify(f.object);
      // I3: never store secret-bearing LLM output.
      if (containsSecret(`${f.predicate} ${objStr} ${f.raw_quote ?? ""}`)) continue;
      // Only keep evidence ids that actually exist (no hallucinated provenance).
      const evidence = f.evidence_ids.filter((id) => validEventIds.has(id));
      out.push({
        subject: f.subject,
        predicate: f.predicate,
        object: f.object,
        fact_kind: f.fact_kind as FactKind,
        temporal_kind: temporalFor(f.fact_kind),
        scope: deps.scope,
        // LLM-extracted facts are NEVER high-trust unless explicitly structured;
        // the model's self-reported tier is capped to low (I2 — prose is low).
        trust_tier: "low",
        confidence: f.confidence,
        status: "candidate", // I1
        promotion_state: "session_only",
        source: {
          asserted_by: "llm_extractor",
          event_ids: evidence,
          raw_quote: f.raw_quote,
        },
        tags: ["llm_extracted"],
      });
    }
    return out;
  } catch {
    return [];
  }
}

function temporalFor(kind: string): NewFact["temporal_kind"] {
  if (kind === "task_state" || kind === "open_loop") return "dynamic";
  if (kind === "preference") return "static";
  return "static";
}

function renderTranscript(episodes: Episode[]): string {
  const lines = episodes.map((e) => {
    const payload = JSON.stringify(e.payload).slice(0, 800);
    return `[${e.event_id}] ${e.event_type}: ${payload}`;
  });
  return `Session events:\n${lines.join("\n")}`;
}

function loadPrompt(file: string): string {
  return readFileSync(join(here, "prompts", file), "utf8");
}
