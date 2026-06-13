import { z } from "zod";

// Config schema (SPEC §5). M0 keeps the full shape but only storage/inject/promote/security
// are exercised; llm/telemetry are present for forward-compat (validated, not used on hot path).

export const storageSchema = z.object({
  user_db: z.string(),
  workspace_db: z.string(),
  episodes: z.string(),
});

export const llmSchema = z.object({
  provider: z.enum(["anthropic", "openai", "local"]),
  chat_model: z.string(),
  embed_model: z.string(),
  api_key_env: z.string(),
  base_url: z.string(),
});

export const injectSchema = z.object({
  total_budget_tokens: z.number().int().positive(),
  budget_fraction: z.number().positive(),
  max_cards: z.number().int().positive(),
  max_cards_pretool: z.number().int().positive(),
  gate_drift_threshold: z.number(),
  enabled_events: z.array(z.string()),
});

export const promoteSchema = z.object({
  session_to_workspace: z.boolean(),
  workspace_to_user: z.enum(["explicit_only", "inferred"]),
  min_procedure_successes: z.number().int().nonnegative(),
  min_failure_repeats: z.number().int().nonnegative(),
});

export const securitySchema = z.object({
  secret_scan: z.boolean(),
  prose_trust: z.literal("low"),
  allow_executable_procedures: z.literal(false),
});

export const telemetrySchema = z.object({
  enabled: z.boolean(),
  local_only: z.boolean(),
});

export const configSchema = z.object({
  storage: storageSchema,
  llm: llmSchema,
  inject: injectSchema,
  promote: promoteSchema,
  security: securitySchema,
  telemetry: telemetrySchema,
});

export type Config = z.infer<typeof configSchema>;
