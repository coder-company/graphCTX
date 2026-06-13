import type { EpisodeEventType, Event, NewEpisode } from "../core/types.js";

// Maps a client lifecycle Event + raw payload into a canonical Episode shape.
// One normalizer per adapter; M0 ships the Claude Code mapping.
const EVENT_MAP: Record<Event, EpisodeEventType | null> = {
  SessionStart: "session_start",
  UserPromptSubmit: "prompt_submitted",
  PreToolUse: "tool_call",
  PostToolUse: "tool_result",
  PreCompact: "pre_compact",
  PostCompact: "post_compact",
  SessionEnd: "session_end",
  FileChanged: "file_changed",
  BranchSwitch: "branch_switch",
};

export function normalizeClaudeEvent(
  event: Event,
  payload: unknown,
  ctx: { session_id: string; workspace_id?: string; git_head?: string; git_branch?: string },
): NewEpisode | null {
  const eventType = EVENT_MAP[event];
  if (!eventType) return null;
  return {
    session_id: ctx.session_id,
    workspace_id: ctx.workspace_id,
    event_type: eventType,
    payload,
    git_head: ctx.git_head,
    git_branch: ctx.git_branch,
  };
}
