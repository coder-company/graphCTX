import type { Capsule, InjectionContext } from "../core/types.js";

export type ChannelTier = 0 | 1 | 2 | 3 | 4;

export interface Capability {
  tiers: ChannelTier[];
  highest: ChannelTier;
}

export interface Adapter {
  id: string;
  detect(): Promise<Capability>;
  install(opts: InstallOptions): Promise<void>;
  uninstall(): Promise<void>;
  deliver(capsule: Capsule, ctx: InjectionContext, tier: ChannelTier): Promise<void>;
}

export interface InstallOptions {
  workspaceDir: string;
  global?: boolean;
  binPath?: string; // command used to invoke graphctx hook <event>
}
