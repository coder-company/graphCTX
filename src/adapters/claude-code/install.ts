import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AdapterError } from "../../core/errors.js";
import type { InstallOptions } from "../adapter.js";

// The lifecycle events we wire (SPEC §17). M0 acts on SessionStart + PostCompact;
// the others are captured for episode logging / future phases.
const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
] as const;

interface ClaudeSettings {
  hooks?: Record<string, unknown[]>;
  [k: string]: unknown;
}

// Writes Claude Code hook entries that call `graphctx hook <event>` with the
// event payload on stdin. Idempotent: replaces any prior graphctx entries.
export function installClaudeHooks(opts: InstallOptions): { settingsPath: string } {
  const bin = opts.binPath ?? "graphctx";
  const dir = opts.global
    ? join(process.env.HOME ?? "", ".claude")
    : join(opts.workspaceDir, ".claude");
  mkdirSync(dir, { recursive: true });
  const settingsPath = join(dir, "settings.json");

  let settings: ClaudeSettings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    } catch (e) {
      throw new AdapterError(
        `cannot parse ${settingsPath}: ${(e as Error).message}`,
        "fix or remove the file",
      );
    }
  }

  settings.hooks = settings.hooks ?? {};
  for (const event of HOOK_EVENTS) {
    const command = `${bin} hook ${event}`;
    settings.hooks[event] = [
      {
        hooks: [{ type: "command", command }],
      },
    ];
  }

  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return { settingsPath };
}

export function uninstallClaudeHooks(opts: InstallOptions): void {
  const dir = opts.global
    ? join(process.env.HOME ?? "", ".claude")
    : join(opts.workspaceDir, ".claude");
  const settingsPath = join(dir, "settings.json");
  if (!existsSync(settingsPath)) return;
  try {
    const settings: ClaudeSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (settings.hooks) {
      for (const event of HOOK_EVENTS) delete settings.hooks[event];
    }
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  } catch {
    // best-effort
  }
}
