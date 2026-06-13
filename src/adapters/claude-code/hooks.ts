import { normalizeClaudeEvent } from "../../capture/normalizers.js";
import type { Capsule, Event } from "../../core/types.js";
import type { Runtime } from "../../runtime.js";

// Claude Code hook payload (subset we use). Field names follow Claude Code's
// hook input schema; unknown fields are ignored.
export interface ClaudeHookPayload {
  session_id?: string;
  hook_event_name?: string;
  transcript_path?: string;
  cwd?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: { success?: boolean; stderr?: string; stdout?: string };
  // graphctx test/eval injection of a transcript tail directly:
  transcript_tail?: string;
  current_files?: string[];
  mentioned_symbols?: string[];
}

const VALID_EVENTS = new Set<Event>([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
]);

export interface HookResult {
  capsule: Capsule;
  // Claude Code-shaped JSON to print on stdout (additionalContext push, Tier 2).
  stdout: string;
}

// Core hook handler. MUST NOT throw — callers degrade to an empty capsule (I9).
export async function handleHook(
  rt: Runtime,
  eventArg: string,
  payload: ClaudeHookPayload,
): Promise<HookResult> {
  const event = eventArg as Event;
  const sessionId = payload.session_id ?? "default-session";

  // Resolve git state for capture context.
  let gitHead: string | undefined;
  let gitBranch: string | undefined;
  try {
    if (await rt.git.isRepo()) {
      gitHead = await rt.git.head();
      gitBranch = await rt.git.branch();
    }
  } catch {
    // degrade
  }

  // 1. Capture the episode (append-only). Never blocks output on failure.
  try {
    const episode = normalizeClaudeEvent(event, sanitizePayload(payload), {
      session_id: sessionId,
      workspace_id: rt.workspaceId,
      git_head: gitHead,
      git_branch: gitBranch,
    });
    if (episode) rt.episodeLog.append(episode);
  } catch {
    // I9
  }

  // 2. On SessionStart, (re)run deterministic extraction so durable facts exist.
  if (event === "SessionStart") {
    try {
      await rt.extract();
    } catch {
      // I9
    }
  }

  // 3. Plan injection for push-eligible events.
  if (!VALID_EVENTS.has(event)) {
    return emptyResult();
  }

  const ctx = await rt.injectionContext(event, sessionId, {
    user_prompt: payload.prompt,
    transcript_tail: payload.transcript_tail ?? (await readTranscriptTail(payload.transcript_path)),
    current_files: payload.current_files,
    mentioned_symbols: payload.mentioned_symbols,
    planned_tool: payload.tool_name
      ? { name: payload.tool_name, args: payload.tool_input }
      : undefined,
    tool_result: payload.tool_response
      ? {
          success: payload.tool_response.success ?? true,
          stderr: payload.tool_response.stderr,
          stdout_tail: payload.tool_response.stdout,
        }
      : undefined,
  });

  const capsule = await rt.planner().plan(ctx);
  return { capsule, stdout: toClaudeStdout(event, capsule) };
}

function emptyResult(): HookResult {
  return {
    capsule: { markdown: "", cards: [], omitted: [], conflicts: [], token_count: 0 },
    stdout: "",
  };
}

// Claude Code reads `hookSpecificOutput.additionalContext` to inject context.
function toClaudeStdout(event: Event, capsule: Capsule): string {
  if (!capsule.markdown) return "";
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: event,
      additionalContext: capsule.markdown,
    },
  });
}

// Strip raw secret-bearing fields from captured payloads (defense in depth).
function sanitizePayload(p: ClaudeHookPayload): unknown {
  return {
    hook_event_name: p.hook_event_name,
    prompt: p.prompt,
    tool_name: p.tool_name,
    tool_input: p.tool_input,
    tool_response: p.tool_response
      ? { success: p.tool_response.success, stderr: truncate(p.tool_response.stderr, 1000) }
      : undefined,
  };
}

function truncate(s: string | undefined, n: number): string | undefined {
  if (!s) return s;
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

async function readTranscriptTail(path?: string): Promise<string | undefined> {
  if (!path) return undefined;
  try {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(path, "utf8");
    return text.slice(-4000);
  } catch {
    return undefined;
  }
}
