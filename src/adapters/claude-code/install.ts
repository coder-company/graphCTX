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
      ...withoutGraphctxHooks(settings.hooks[event], event),
      graphctxHookGroup(command),
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
  let settings: ClaudeSettings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (e) {
    throw new AdapterError(
      `cannot parse ${settingsPath}: ${(e as Error).message}`,
      "fix or remove the file",
    );
  }
  if (settings.hooks) {
    for (const event of HOOK_EVENTS) {
      const kept = withoutGraphctxHooks(settings.hooks[event], event);
      if (kept.length > 0) settings.hooks[event] = kept;
      else settings.hooks[event] = [];
    }
  }
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

export function hasClaudeGraphctxHooks(opts: InstallOptions): boolean {
  const dir = opts.global
    ? join(process.env.HOME ?? "", ".claude")
    : join(opts.workspaceDir, ".claude");
  const settingsPath = join(dir, "settings.json");
  if (!existsSync(settingsPath)) return false;
  try {
    const settings: ClaudeSettings = JSON.parse(readFileSync(settingsPath, "utf8"));
    return HOOK_EVENTS.every((event) => hasGraphctxHook(settings.hooks?.[event], event));
  } catch {
    return false;
  }
}

function hasGraphctxHook(value: unknown, event: string): boolean {
  if (Array.isArray(value)) return value.some((item) => hasGraphctxHook(item, event));
  if (!isRecord(value)) return false;

  const command = value.command;
  if (typeof command === "string" && isGraphctxHookCommand(command, event)) {
    return true;
  }

  return hasGraphctxHook(value.hooks, event);
}

function withoutGraphctxHooks(value: unknown, event: string): unknown[] {
  if (!Array.isArray(value)) return [];
  const kept: unknown[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      kept.push(item);
      continue;
    }
    if (Array.isArray(item.hooks)) {
      const hooks = item.hooks.filter((hook) => !hookMatchesGraphctx(hook, event));
      if (hooks.length > 0) kept.push({ ...item, hooks });
      continue;
    }
    if (!hasGraphctxHook(item, event)) kept.push(item);
  }
  return kept;
}

function hookMatchesGraphctx(value: unknown, event: string): boolean {
  if (!isRecord(value)) return false;
  return typeof value.command === "string" && isGraphctxHookCommand(value.command, event);
}

function isGraphctxHookCommand(command: string, event: string): boolean {
  if (!command.includes(`hook ${event}`)) return false;
  return (
    /\bgraphctx\b/i.test(command) ||
    /(?:^|\s)(?:node|tsx|npx tsx)\s+\S*\/cli\.(?:js|ts)(?:\s|$)/.test(command)
  );
}

function graphctxHookGroup(command: string): {
  hooks: Array<{ type: "command"; command: string }>;
} {
  return { hooks: [{ type: "command", command }] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
