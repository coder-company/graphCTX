import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { ConfigError } from "../core/errors.js";
import { configDir, dataDir, defaultConfig } from "./defaults.js";
import { type Config, configSchema } from "./schema.js";

// Deep-merge helper for partial config overrides.
function deepMerge<T>(base: T, override: unknown): T {
  if (override === null || typeof override !== "object") return base;
  const out = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(override as Record<string, unknown>)) {
    const cur = out[k];
    if (v && typeof v === "object" && !Array.isArray(v) && cur && typeof cur === "object") {
      out[k] = deepMerge(cur, v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

function readJsonIfExists(path: string): unknown {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(
      `failed to parse config ${path}: ${(e as Error).message}`,
      "fix JSON syntax",
    );
  }
}

// Env overrides: GRAPHCTX_INJECT_TOTAL_BUDGET_TOKENS etc. Minimal in M0.
function envOverrides(): Record<string, unknown> {
  const inject: Record<string, unknown> = {};
  const t = process.env.GRAPHCTX_INJECT_TOTAL_BUDGET_TOKENS;
  if (t) inject.total_budget_tokens = Number(t);
  return Object.keys(inject).length ? { inject } : {};
}

export interface LoadOptions {
  workspaceDir?: string;
  overrides?: Partial<Config>;
}

export interface LoadedConfig {
  config: Config;
  workspaceDir: string;
  // Resolved absolute paths for the current workspace.
  paths: { userDb: string; workspaceDb: string; episodes: string };
}

// Resolution order (later overrides earlier): defaults → ~/.config → <ws>/.graphctx → env → CLI.
export function loadConfig(opts: LoadOptions = {}): LoadedConfig {
  const workspaceDir = resolve(opts.workspaceDir ?? process.cwd());
  let merged: Config = defaultConfig();
  merged = deepMerge(merged, readJsonIfExists(join(configDir(), "config.json")));
  merged = deepMerge(merged, readJsonIfExists(join(workspaceDir, ".graphctx", "config.json")));
  merged = deepMerge(merged, envOverrides());
  if (opts.overrides) merged = deepMerge(merged, opts.overrides);

  const parsed = configSchema.safeParse(merged);
  if (!parsed.success) {
    throw new ConfigError(`invalid config: ${parsed.error.message}`, "check config values");
  }
  const cfg = parsed.data;

  const userDb = expandPath(cfg.storage.user_db, workspaceDir);
  const workspaceDb =
    cfg.storage.workspace_db === "global"
      ? join(dataDir(), "workspaces", `${hashPath(workspaceDir)}.db`)
      : expandPath(cfg.storage.workspace_db, workspaceDir);
  const episodes = expandPath(cfg.storage.episodes, workspaceDir);

  return { config: cfg, workspaceDir, paths: { userDb, workspaceDb, episodes } };
}

function expandPath(p: string, workspaceDir: string): string {
  let out = p;
  if (out.startsWith("~")) out = join(process.env.HOME ?? "", out.slice(1));
  if (out.includes("~/.local/share/graphctx")) {
    out = out.replace(/^.*\.local\/share\/graphctx/, dataDir());
  }
  return isAbsolute(out) ? out : join(workspaceDir, out);
}

function hashPath(p: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < p.length; i++) {
    h ^= p.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
