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
    return writeAgentsCapsuleFacts(this.workspaceDir, factsFromCapsule(capsule));
  }

  // Tier 1: a rider snippet for a tool response.
  rider(capsule: Capsule): string {
    return buildRider(capsule);
  }
}
