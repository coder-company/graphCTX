import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Capsule, InjectionContext } from "../../core/types.js";
import type { Adapter, Capability, ChannelTier, InstallOptions } from "../adapter.js";
import { factsFromCapsule, writeAgentsCapsuleFacts } from "../boot-capsule.js";
import { buildRider } from "../channel.js";

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
    // Mark the explicit generic install. The AGENTS.md floor itself is written
    // by the CLI after extraction, but init also writes AGENTS.md; the marker
    // lets doctor distinguish "installed generic" from "just initialized".
    const marker = genericInstallMarker(this.workspaceDir);
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, `${JSON.stringify({ adapter: "generic" }, null, 2)}\n`, "utf8");
  }

  async uninstall(): Promise<void> {
    rmSync(genericInstallMarker(this.workspaceDir), { force: true });
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
    return writeAgentsCapsuleFacts(this.workspaceDir, factsFromCapsule(capsule));
  }

  // Tier 1: a rider snippet for a tool response.
  rider(capsule: Capsule): string {
    return buildRider(capsule);
  }
}

export function hasGenericGraphctxInstall(workspaceDir: string): boolean {
  return existsSync(genericInstallMarker(workspaceDir));
}

function genericInstallMarker(workspaceDir: string): string {
  return join(workspaceDir, ".graphctx", "adapters", "generic.json");
}
