import type { Event, InjectionContext } from "../core/types.js";

export interface GateConfig {
  enabledEvents: string[];
  driftThreshold: number;
}

// Relevance gate (SPEC §15, GAMEPLAN §5.2). M0 scope: SessionStart and
// PostCompact ALWAYS fire; other events are gated (and largely deferred to M2).
export function shouldFire(ctx: InjectionContext, cfg: GateConfig): boolean {
  if (!cfg.enabledEvents.includes(ctx.event)) return false;

  switch (ctx.event) {
    case "SessionStart":
    case "PostCompact":
      return true; // always fire — beachhead (D12)
    case "UserPromptSubmit":
      return hasNewEntities(ctx); // centroid drift deferred to M2; entity-change in M0
    case "PreToolUse":
      return planPlausiblyHasMemory(ctx);
    case "PostToolUse":
      return ctx.tool_result?.success === false;
    default:
      return false;
  }
}

function hasNewEntities(ctx: InjectionContext): boolean {
  return (ctx.current_files?.length ?? 0) + (ctx.mentioned_symbols?.length ?? 0) > 0;
}

function planPlausiblyHasMemory(ctx: InjectionContext): boolean {
  const name = ctx.planned_tool?.name?.toLowerCase() ?? "";
  return name.includes("bash") || name.includes("edit") || name.includes("write");
}

export const ALWAYS_FIRE_EVENTS: Event[] = ["SessionStart", "PostCompact"];
