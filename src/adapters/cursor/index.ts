import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isoNow } from "../../core/clock.js";
import type { Capsule, InjectionContext } from "../../core/types.js";
import type { Adapter, Capability, ChannelTier, InstallOptions } from "../adapter.js";
import { renderAgentsCapsule } from "../claude-code/templates/agents.js";

// Cursor adapter (SPEC §17). Cursor has no lifecycle push hooks, but supports:
//   Tier 0 — project rules (.cursor/rules/*.mdc) loaded as grounding, and
//   Tier 1 — MCP tool-response riders (Cursor is an MCP client).
// So capability tops out at Tier 1. Install writes a graphCTX rule + MCP config.
export class CursorAdapter implements Adapter {
  readonly id = "cursor";
  private readonly workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  async detect(): Promise<Capability> {
    const tiers: ChannelTier[] = [0, 1];
    return { tiers, highest: 1 };
  }

  async install(opts: InstallOptions): Promise<void> {
    const bin = opts.binPath ?? "graphctx";
    // Tier 0: a project rule that grounds + directs recall.
    const rulesDir = join(this.workspaceDir, ".cursor", "rules");
    mkdirSync(rulesDir, { recursive: true });
    const rule = [
      "---",
      "description: graphCTX memory grounding",
      "alwaysApply: true",
      "---",
      "",
      "This project uses graphCTX for durable memory. At the start of a task and",
      "whenever you are unsure of a project convention, call the graphCTX `recall`",
      "MCP tool. Treat injected `[mem:*]` context as authoritative project memory.",
      "",
    ].join("\n");
    writeFileSync(join(rulesDir, "graphctx.mdc"), rule, "utf8");

    // Tier 1: register the MCP server in Cursor's mcp.json.
    const mcpPath = join(this.workspaceDir, ".cursor", "mcp.json");
    let mcp: { mcpServers?: Record<string, unknown> } = {};
    if (existsSync(mcpPath)) {
      try {
        mcp = JSON.parse(readFileSync(mcpPath, "utf8"));
      } catch {
        mcp = {};
      }
    }
    mcp.mcpServers = mcp.mcpServers ?? {};
    mcp.mcpServers.graphctx = { command: bin, args: ["serve", "--mcp"] };
    writeFileSync(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`, "utf8");
  }

  async uninstall(): Promise<void> {
    const mcpPath = join(this.workspaceDir, ".cursor", "mcp.json");
    if (!existsSync(mcpPath)) return;
    try {
      const mcp = JSON.parse(readFileSync(mcpPath, "utf8")) as {
        mcpServers?: Record<string, unknown>;
      };
      if (mcp.mcpServers) mcp.mcpServers.graphctx = undefined;
      writeFileSync(mcpPath, `${JSON.stringify(mcp, null, 2)}\n`, "utf8");
    } catch {
      // best-effort
    }
  }

  async deliver(capsule: Capsule, _ctx: InjectionContext, _tier: ChannelTier): Promise<void> {
    // Refresh the AGENTS.md floor (Cursor also reads it); rider is served by MCP.
    const facts = capsule.markdown
      .split("\n")
      .filter((l) => l.trim().startsWith("-"))
      .map((l) => l.replace(/^- /, "").replace(/\s*\[mem:[^\]]+\]$/, ""));
    const rendered = renderAgentsCapsule({ facts, generatedAt: isoNow() });
    const path = join(this.workspaceDir, "AGENTS.md");
    let content = rendered;
    if (existsSync(path)) content = `${readFileSync(path, "utf8").trimEnd()}\n\n${rendered}\n`;
    writeFileSync(path, content, "utf8");
  }
}
