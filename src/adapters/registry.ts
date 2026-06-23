import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Adapter } from "./adapter.js";
import { ClaudeAdapter } from "./claude-code/index.js";
import { CodexAdapter } from "./codex/index.js";
import { CursorAdapter } from "./cursor/index.js";
import { GenericAdapter } from "./generic/index.js";
import { OpenCodeAdapter } from "./opencode/index.js";
import { ProxyAdapter } from "./proxy/index.js";

export type ClientId = "claude" | "cursor" | "opencode" | "codex" | "generic" | "proxy";

// Build a named adapter for a workspace.
export function makeAdapter(client: ClientId, workspaceDir: string): Adapter {
  switch (client) {
    case "claude":
      return new ClaudeAdapter(workspaceDir);
    case "cursor":
      return new CursorAdapter(workspaceDir);
    case "opencode":
      return new OpenCodeAdapter(workspaceDir);
    case "codex":
      return new CodexAdapter(workspaceDir);
    case "proxy":
      return new ProxyAdapter(workspaceDir, { enabled: false });
    case "generic":
      return new GenericAdapter(workspaceDir);
  }
}

// Auto-detect which client a workspace is set up for, by sniffing config files.
// Falls back to "generic" so EVERY workspace gets at least Tier 0 + Tier 1.
// Codex is deliberately NOT auto-detected from `~/.codex/` — its MCP config is
// user-global and we never edit user-global config without an explicit
// `graphctx install codex`.
export function detectClient(workspaceDir: string): ClientId {
  if (existsSync(join(workspaceDir, ".claude")) || existsSync(join(workspaceDir, "CLAUDE.md"))) {
    return "claude";
  }
  if (existsSync(join(workspaceDir, ".cursor"))) return "cursor";
  if (
    existsSync(join(workspaceDir, "opencode.json")) ||
    existsSync(join(workspaceDir, ".opencode"))
  ) {
    return "opencode";
  }
  return "generic";
}
