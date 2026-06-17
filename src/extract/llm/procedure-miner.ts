import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Episode, Scope } from "../../core/types.js";
import type { ChatMessage, LlmProvider } from "../../llm/provider.js";
import { parseJsonResponse } from "../../llm/provider.js";
import { containsSecret } from "../../security/secrets.js";
import type { ProcedureStep, ProcedureVerifier } from "../../store/procedures.repo.js";

const here = dirname(fileURLToPath(import.meta.url));

const stepSchema = z.object({
  description: z.string().min(1),
  command: z.string().nullable().optional(),
});
const procedureSchema = z.object({
  name: z.string().min(1),
  steps: z.array(stepSchema).min(1),
  verifier: z
    .object({
      command: z.string().nullable().optional(),
      expected_exit_code: z.number().optional(),
    })
    .optional(),
  evidence_ids: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
});
const batchSchema = z.object({ procedures: z.array(procedureSchema).default([]) });
const procedureBatchJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["procedures"],
  properties: {
    procedures: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "steps", "evidence_ids"],
        properties: {
          name: { type: "string" },
          steps: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["description"],
              properties: {
                description: { type: "string" },
                command: { type: ["string", "null"] },
              },
            },
          },
          verifier: {
            type: "object",
            additionalProperties: false,
            properties: {
              command: { type: ["string", "null"] },
              expected_exit_code: { type: "number" },
            },
          },
          evidence_ids: { type: "array", items: { type: "string" } },
          confidence: { type: "number" },
        },
      },
    },
  },
} satisfies Record<string, unknown>;

export interface MinedProcedure {
  name: string;
  steps: ProcedureStep[];
  verifier?: ProcedureVerifier;
  evidence_ids: string[];
  confidence: number;
  scope: Scope;
}

export interface ProcedureMineDeps {
  provider: LlmProvider;
  scope: Scope;
  promptVersion?: string;
}

// Procedure mining (SPEC §10.2, D10). DESCRIPTIVE ONLY — no auto-run. Async,
// fail-soft. Returns mined procedures for the caller to persist as a procedural
// fact + procedures-table row.
export async function mineProcedures(
  episodes: Episode[],
  deps: ProcedureMineDeps,
): Promise<MinedProcedure[]> {
  if (!deps.provider.available || episodes.length === 0) return [];
  try {
    const prompt = loadPrompt(deps.promptVersion ?? "procedure_mine.v1.md");
    const transcript = renderTranscript(episodes);
    const messages: ChatMessage[] = [
      { role: "system", content: prompt },
      { role: "user", content: transcript },
    ];
    const { text } = await deps.provider.chat({
      messages,
      json: true,
      jsonSchema: procedureBatchJsonSchema,
      temperature: 0,
    });
    const parsed = parseJsonResponse<unknown>(text);
    if (!parsed) return [];
    const batch = batchSchema.safeParse(parsed);
    if (!batch.success) return [];

    const validEventIds = new Set(episodes.map((e) => e.event_id));
    const out: MinedProcedure[] = [];
    for (const p of batch.data.procedures) {
      const blob = `${p.name} ${p.steps.map((s) => `${s.description} ${s.command ?? ""}`).join(" ")}`;
      if (containsSecret(blob)) continue; // I3
      out.push({
        name: p.name,
        steps: p.steps.map((s) => ({ description: s.description, command: s.command ?? null })),
        verifier: p.verifier
          ? {
              command: p.verifier.command ?? null,
              expected_exit_code: p.verifier.expected_exit_code,
            }
          : undefined,
        evidence_ids: p.evidence_ids.filter((id) => validEventIds.has(id)),
        confidence: p.confidence,
        scope: deps.scope,
      });
    }
    return out;
  } catch {
    return [];
  }
}

function renderTranscript(episodes: Episode[]): string {
  const lines = episodes.map(
    (e) => `[${e.event_id}] ${e.event_type}: ${JSON.stringify(e.payload).slice(0, 800)}`,
  );
  return `Session events:\n${lines.join("\n")}`;
}

function loadPrompt(file: string): string {
  return readFileSync(join(here, "prompts", file), "utf8");
}
