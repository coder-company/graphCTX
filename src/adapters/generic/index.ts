import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isoNow } from "../../core/clock.js";
import type { Capsule, InjectionContext } from "../../core/types.js";
import type { Adapter, Capability, ChannelTier, InstallOptions } from "../adapter.js";
import { buildRider } from "../channel.js";
import { renderAgentsCapsule } from "../claude-code/templates/agents.js";

// Generic adapter for ANY client (SPEC §17). No native hooks → we deliver via:
//   Tier 0 — write/refresh an AGENTS.md boot capsule (grounding floor), and
//   Tier 1 — expose a rider snippet appended to MCP tool responses.
// This guarantees every client gets at least T0 + T1 even with zero integration.
export class GenericAdapter implements Adapter {
  readonly id = "generic";
  private readonly workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  async detect(): Promise<Capability> {
    // Hookless baseline: floor + parasitic rider are always available.
    const tiers: ChannelTier[] = [0, 1];
    return { tiers, highest: 1 };
  }

  async install(_opts: InstallOptions): Promise<void> {
    // Nothing to wire beyond the AGENTS.md floor, written on deliver(T0).
  }

  async uninstall(): Promise<void> {
    // Leave AGENTS.md in place; it's user-visible content.
  }

  async deliver(capsule: Capsule, _ctx: InjectionContext, tier: ChannelTier): Promise<void> {
    if (tier <= 0) {
      this.writeFloor(capsule);
      return;
    }
    // Tier 1 rider is consumed by the MCP layer (returned to tool responses);
    // for the generic file-only path we also keep the floor fresh.
    this.writeFloor(capsule);
  }

  // Tier 0: write the boot capsule into AGENTS.md (idempotent, preserves user
  // content outside the graphCTX markers).
  writeFloor(capsule: Capsule): string {
    const facts = capsule.cards.length
      ? capsule.markdown
          .split("\n")
          .filter((l) => l.trim().startsWith("-"))
          .map((l) => l.replace(/^- /, "").replace(/\s*\[mem:[^\]]+\]$/, ""))
      : [];
    const rendered = renderAgentsCapsule({ facts, generatedAt: isoNow() });
    const path = join(this.workspaceDir, "AGENTS.md");
    let content = rendered;
    if (existsSync(path)) {
      const existing = readFileSync(path, "utf8");
      content = mergeCapsule(existing, rendered);
    }
    writeFileSync(path, content, "utf8");
    return path;
  }

  // Tier 1: a rider snippet for a tool response.
  rider(capsule: Capsule): string {
    return buildRider(capsule);
  }
}

const BEGIN = "<!-- graphctx:begin -->";
const END = "<!-- graphctx:end -->";

function mergeCapsule(existing: string, rendered: string): string {
  const block = rendered.includes(BEGIN) ? rendered : `${BEGIN}\n${rendered}\n${END}`;
  if (existing.includes(BEGIN) && existing.includes(END)) {
    return existing.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}`), block.trim());
  }
  return `${existing.trimEnd()}\n\n${block}\n`;
}
