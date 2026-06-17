import type { Capsule, InjectionContext } from "../../core/types.js";
import type { Adapter, Capability, ChannelTier, InstallOptions } from "../adapter.js";
import { factsFromCapsule, writeAgentsCapsuleFacts } from "../boot-capsule.js";
import { installClaudeHooks, uninstallClaudeHooks } from "./install.js";

// Claude Code has a static AGENTS.md floor (Tier 0) plus lifecycle hooks that
// push live additionalContext (Tier 2).
export class ClaudeAdapter implements Adapter {
  readonly id = "claude";
  private readonly workspaceDir: string;

  constructor(workspaceDir: string) {
    this.workspaceDir = workspaceDir;
  }

  async detect(): Promise<Capability> {
    return { tiers: [0, 2], highest: 2 };
  }

  async install(opts: InstallOptions): Promise<void> {
    installClaudeHooks({ ...opts, workspaceDir: this.workspaceDir });
  }

  async uninstall(): Promise<void> {
    uninstallClaudeHooks({ workspaceDir: this.workspaceDir });
  }

  async deliver(capsule: Capsule, _ctx: InjectionContext, _tier: ChannelTier): Promise<void> {
    writeAgentsCapsuleFacts(this.workspaceDir, factsFromCapsule(capsule));
  }
}
