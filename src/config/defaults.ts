import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "./schema.js";

export function dataDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  return xdg ? join(xdg, "graphctx") : join(homedir(), ".local", "share", "graphctx");
}

export function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  return xdg ? join(xdg, "graphctx") : join(homedir(), ".config", "graphctx");
}

export function defaultConfig(): Config {
  return {
    storage: {
      user_db: join(dataDir(), "user.db"),
      workspace_db: ".graphctx/workspace.db",
      episodes: ".graphctx/episodes.jsonl",
    },
    llm: {
      provider: "anthropic",
      chat_model: "claude-haiku",
      embed_model: "text-embedding-3-small",
      api_key_env: "ANTHROPIC_API_KEY",
      base_url: "",
    },
    inject: {
      total_budget_tokens: 2500,
      budget_fraction: 0.015,
      max_cards: 15,
      max_cards_pretool: 5,
      gate_drift_threshold: 0.35,
      enabled_events: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostCompact"],
    },
    promote: {
      session_to_workspace: true,
      workspace_to_user: "explicit_only",
      min_procedure_successes: 2,
      min_failure_repeats: 2,
    },
    security: {
      secret_scan: true,
      prose_trust: "low",
      allow_executable_procedures: false,
    },
    telemetry: {
      enabled: true,
      local_only: true,
    },
  };
}
