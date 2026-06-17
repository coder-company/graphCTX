import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Capsule, InjectionContext } from "../../core/types.js";
import type { Adapter, Capability, ChannelTier, InstallOptions } from "../adapter.js";
import { factsFromCapsule, writeAgentsCapsuleFacts } from "../boot-capsule.js";

// OpenCode adapter (SPEC §17). OpenCode reads AGENTS.md (Tier 0) and is an MCP
// client (Tier 1 riders), and additionally supports plugin/event hooks that can
// honor server-initiated context — modeled as Tier 3 (best-effort). Capability
// tops out at Tier 3 where available, else Tier 1.
export class OpenCodeAdapter implements Adapter {
  readonly id = "opencode";
  private readonly workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  async detect(): Promise<Capability> {
    // AGENTS.md + MCP always; Tier 3 notifications when an opencode config exists.
    const tiers: ChannelTier[] = [0, 1];
    const hasConfig =
      existsSync(join(this.workspaceDir, "opencode.json")) ||
      existsSync(join(this.workspaceDir, ".opencode"));
    if (hasConfig) tiers.push(3);
    return { tiers, highest: tiers[tiers.length - 1]! };
  }

  async install(opts: InstallOptions): Promise<void> {
    const bin = opts.binPath ?? "graphctx";
    const cfgPath = join(this.workspaceDir, "opencode.json");
    let cfg: { mcp?: Record<string, unknown> } = {};
    if (existsSync(cfgPath)) {
      try {
        cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
      } catch {
        cfg = {};
      }
    }
    cfg.mcp = cfg.mcp ?? {};
    cfg.mcp.graphctx = { type: "local", command: [bin, "serve", "--mcp"], enabled: true };
    writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  }

  async uninstall(): Promise<void> {
    const cfgPath = join(this.workspaceDir, "opencode.json");
    if (!existsSync(cfgPath)) return;
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { mcp?: Record<string, unknown> };
      if (cfg.mcp) cfg.mcp.graphctx = undefined;
      writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
    } catch {
      // best-effort
    }
  }

  async deliver(capsule: Capsule, _ctx: InjectionContext, _tier: ChannelTier): Promise<void> {
    writeAgentsCapsuleFacts(this.workspaceDir, factsFromCapsule(capsule));
  }
}

export function hasOpenCodeGraphctxInstall(workspaceDir: string): boolean {
  const cfgPath = join(workspaceDir, "opencode.json");
  if (!existsSync(cfgPath)) return false;
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as { mcp?: Record<string, unknown> };
    const entry = cfg.mcp?.graphctx;
    return isRecord(entry) && entry.enabled === true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
