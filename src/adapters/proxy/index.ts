import type { Capsule, InjectionContext } from "../../core/types.js";
import { containsSecret } from "../../security/secrets.js";
import type { Adapter, Capability, ChannelTier, InstallOptions } from "../adapter.js";

// Tier 4 proxy / interception adapter (SPEC §17, GAMEPLAN §5.1). The NUCLEAR
// option for hookless clients: rewrite the outgoing context on every turn. It is
// invasive and security-sensitive, so it is:
//   - OPT-IN ONLY (disabled unless explicitly enabled), and
//   - SECURE: the rewrite is refused if the capsule trips the secret scanner
//     (defense in depth on top of the planner's pre-send scan, I3).
export interface ProxyOptions {
  enabled: boolean; // must be explicitly true to do anything
}

export interface ProxyRewrite {
  applied: boolean;
  reason?: string;
  augmentedPrompt?: string;
}

export class ProxyAdapter implements Adapter {
  readonly id = "proxy";
  private readonly workspaceDir: string;
  private readonly opts: ProxyOptions;

  constructor(workspaceDir: string, opts: ProxyOptions = { enabled: false }) {
    this.workspaceDir = workspaceDir;
    this.opts = opts;
  }

  async detect(): Promise<Capability> {
    // The proxy advertises Tier 4 ONLY when explicitly enabled; otherwise it is
    // inert (no tiers) so capability detection never silently routes through it.
    if (!this.opts.enabled) return { tiers: [], highest: 0 };
    return { tiers: [4], highest: 4 };
  }

  async install(_opts: InstallOptions): Promise<void> {
    // Proxy wiring (e.g. ANTHROPIC_BASE_URL override) is environment-specific and
    // intentionally NOT auto-written — enabling interception is a user decision.
  }

  async uninstall(): Promise<void> {}

  async deliver(capsule: Capsule, ctx: InjectionContext, _tier: ChannelTier): Promise<void> {
    this.rewrite(ctx.user_prompt ?? "", capsule);
  }

  // Rewrite an outgoing prompt by prepending the capsule. SECURE: refuses if the
  // capsule carries a secret, or if the proxy is not explicitly enabled.
  rewrite(outgoingPrompt: string, capsule: Capsule): ProxyRewrite {
    if (!this.opts.enabled) return { applied: false, reason: "proxy disabled (opt-in only)" };
    if (!capsule.markdown) return { applied: false, reason: "empty capsule" };
    if (containsSecret(capsule.markdown)) {
      return { applied: false, reason: "refused: capsule tripped secret scanner (I3)" };
    }
    const augmentedPrompt = `${capsule.markdown}\n\n---\n\n${outgoingPrompt}`;
    return { applied: true, augmentedPrompt };
  }
}
