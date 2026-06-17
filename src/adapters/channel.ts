import type { Capsule, InjectionContext } from "../core/types.js";
import type { ChannelTier } from "./adapter.js";

// Channel ladder (SPEC §17, GAMEPLAN §5.1). The SAME capsule is routed through
// the strongest available tier; the channel only changes the TRANSPORT, never
// the content. Capability detection picks the highest tier a client supports.
//
//   0 Floor      — AGENTS.md/CLAUDE.md boot capsule (session start grounding)
//   1 Parasitic  — rider appended to every MCP tool response (re-grounding)
//   2 Real push  — lifecycle hooks (crown jewel; model can't decline)
//   3 Future push— MCP server-initiated notifications (if client honors)
//   4 Nuclear    — proxy interception (hookless fallback; opt-in, secure)

export interface DeliveryResult {
  tier: ChannelTier;
  delivered: boolean;
  transport: string; // how it was delivered (for telemetry / tests)
  payload?: string; // the channel-shaped payload (stdout JSON, rider text, file)
}

// Pick the highest tier that is BOTH supported by the client and appropriate
// for the event. Tier 2 (hooks) is preferred for mid-session events; Tier 0 is
// the floor for SessionStart grounding; Tier 1 rides tool responses.
export function selectTier(available: ChannelTier[], ctx: InjectionContext): ChannelTier {
  if (available.length === 0) return 0;
  const sorted = [...available].sort((a, b) => b - a);
  // SessionStart can always use the floor in addition to the highest push tier;
  // here we return the highest push tier for the mid-session events and let the
  // adapter additionally refresh Tier 0 on SessionStart.
  return sorted[0]!;
}

// Tier 1 parasitic rider: a TINY fresh-context snippet appended to a tool
// response. Bounded hard so it never bloats the response.
export function buildRider(capsule: Capsule, maxChars = 600): string {
  if (!capsule.markdown) return "";
  const header = "\n\n<!-- graphCTX rider -->\n";
  const bodyBudget = Math.max(0, maxChars - header.length);
  const body =
    capsule.markdown.length > bodyBudget
      ? `${capsule.markdown.slice(0, Math.max(0, bodyBudget - 1))}…`
      : capsule.markdown;
  return `${header}${body}`;
}

// Tier 2 push payload (Claude-style additionalContext JSON).
export function buildHookPayload(event: string, capsule: Capsule): string {
  if (!capsule.markdown) return "";
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: capsule.markdown },
  });
}
