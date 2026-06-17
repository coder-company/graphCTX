import { z } from "zod";
import { writeAgentsCapsule } from "../adapters/boot-capsule.js";
import type { Event } from "../core/types.js";
import { redactWhyReport } from "../provenance/why.js";
import { resolveConflicts } from "../resolve/conflicts.js";
import type { Runtime } from "../runtime.js";
import { assertSafeMemoryWrite } from "../security/intake.js";

// The EXACTLY 8 MCP tools (SPEC §18, I8). One handler each; each validates input
// with zod and returns structured output. The MCP server enforces the count.
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema for tools/list
  outputSchema: Record<string, unknown>; // JSON Schema for successful structuredContent
  handler: (rt: Runtime, args: unknown) => Promise<unknown>;
}

const factKindValues = [
  "semantic",
  "procedural",
  "preference",
  "decision",
  "constraint",
  "failure",
  "task_state",
  "open_loop",
] as const;

const rememberInput = z.object({
  text: z.string().min(1),
  kind: z.enum(factKindValues).default("semantic"),
  subject: z.string().default("user"),
  predicate: z.string().default("note"),
  session_id: z.string().optional(),
});

const recallInput = z.object({
  query: z.string().min(1),
  budget_tokens: z.number().int().positive().optional(),
  session_id: z.string().optional(),
});

const lifecycleEvents = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SessionEnd",
  "FileChanged",
  "BranchSwitch",
] as const satisfies readonly Event[];

const injectInput = z.object({
  event: z.enum(lifecycleEvents).default("UserPromptSubmit"),
  session_id: z.string().default("mcp-session"),
  user_prompt: z.string().optional(),
});

const checkpointInput = z.object({ session_id: z.string().default("mcp-session") });
const promoteInput = z.object({
  session_id: z.string().optional(),
  dry_run: z.boolean().default(false),
});
const forgetInput = z.object({
  fact_id: z.string().min(1),
  reason: z.string().default("user forget"),
});
const whyInput = z.object({ fact_id: z.string().min(1) });
const resolveInput = z.object({ session_id: z.string().optional() });

// JSON Schema helpers (minimal — enough for tools/list discovery).
const s = (props: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: props,
  required,
});
const str = { type: "string" };
const num = { type: "number" };
const nonEmptyStr = { type: "string", minLength: 1 };
const positiveInt = { type: "integer", minimum: 1 };
const bool = { type: "boolean" };
const arr = (items: Record<string, unknown>) => ({ type: "array", items });
const obj = { type: "object" };
const factKindSchema = { type: "string", enum: [...factKindValues] };
const eventSchema = { type: "string", enum: [...lifecycleEvents] };

export const MCP_TOOLS: McpTool[] = [
  {
    name: "remember",
    description: "Store a user-asserted fact/event/procedure in graphCTX memory.",
    inputSchema: s(
      { text: nonEmptyStr, kind: factKindSchema, subject: str, predicate: str, session_id: str },
      ["text"],
    ),
    outputSchema: s({ fact_id: str, status: str }, ["fact_id", "status"]),
    async handler(rt, args) {
      const a = rememberInput.parse(args);
      assertSafeMemoryWrite(a.text);
      const fact = await rt.learn({
        subject: a.subject,
        predicate: a.predicate,
        object: a.text,
        fact_kind: a.kind,
        temporal_kind: a.kind === "task_state" || a.kind === "open_loop" ? "dynamic" : "static",
        scope: rt.scope(a.session_id),
        trust_tier: "high", // user-asserted via explicit tool call
        status: "active",
        promotion_state: a.session_id ? "session_only" : "workspace_active",
        source: { asserted_by: "user", event_ids: [], raw_quote: `user said: ${a.text}` },
        tags: ["mcp_remember"],
      });
      refreshAgentsCapsule(rt);
      return { fact_id: fact.fact_id, status: fact.status };
    },
  },
  {
    name: "recall",
    description: "Pull retrieval (fallback path; push is primary). Returns ranked memory cards.",
    inputSchema: s({ query: nonEmptyStr, budget_tokens: positiveInt, session_id: str }, ["query"]),
    outputSchema: s({ markdown: str, cards: arr(obj), tokens: num }, [
      "markdown",
      "cards",
      "tokens",
    ]),
    async handler(rt, args) {
      const a = recallInput.parse(args);
      const ctx = await rt.injectionContext("UserPromptSubmit", a.session_id ?? "mcp-session", {
        user_prompt: a.query,
        budget_tokens: a.budget_tokens,
      });
      const capsule = await rt.planner().plan(ctx, { bypassGate: true });
      return { markdown: capsule.markdown, cards: capsule.cards, tokens: capsule.token_count };
    },
  },
  {
    name: "inject_context",
    description: "Build and return the injection capsule for a lifecycle event.",
    inputSchema: s({ event: eventSchema, session_id: str, user_prompt: str }),
    outputSchema: s({ markdown: str, cards: arr(obj), tokens: num }, [
      "markdown",
      "cards",
      "tokens",
    ]),
    async handler(rt, args) {
      const a = injectInput.parse(args);
      const ctx = await rt.injectionContext(a.event, a.session_id, {
        user_prompt: a.user_prompt,
      });
      const capsule = await rt.planner().plan(ctx);
      return { markdown: capsule.markdown, cards: capsule.cards, tokens: capsule.token_count };
    },
  },
  {
    name: "checkpoint_session",
    description: "Persist session state (run promotion sweep on pre-compact / session end).",
    inputSchema: s({ session_id: str }),
    outputSchema: s({ promoted: obj }, ["promoted"]),
    async handler(rt, args) {
      const a = checkpointInput.parse(args);
      const swept = await rt.runPromotionSweep(a.session_id);
      refreshAgentsCapsule(rt);
      return { promoted: swept };
    },
  },
  {
    name: "promote",
    description: "Run the session→workspace promotion sweep (dry-run supported).",
    inputSchema: s({ session_id: str, dry_run: bool }),
    outputSchema: s({ dry_run: bool, candidate_count: num, promoted: obj }),
    async handler(rt, args) {
      const a = promoteInput.parse(args);
      if (a.dry_run) {
        const candidates = rt.facts.candidates(rt.scope(a.session_id));
        return { dry_run: true, candidate_count: candidates.length };
      }
      const swept = await rt.runPromotionSweep(a.session_id);
      refreshAgentsCapsule(rt);
      return { promoted: swept };
    },
  },
  {
    name: "forget",
    description: "Expire a fact so it stops being recalled/injected.",
    inputSchema: s({ fact_id: nonEmptyStr, reason: str }, ["fact_id"]),
    outputSchema: s({ fact_id: str, status: str }, ["fact_id", "status"]),
    async handler(rt, args) {
      const a = forgetInput.parse(args);
      const id = rt.resolveFactId(a.fact_id);
      if (!id) throw new Error(`fact not found: ${a.fact_id}`);
      rt.facts.expire(id, id);
      refreshAgentsCapsule(rt);
      return { fact_id: id, status: "expired" };
    },
  },
  {
    name: "why",
    description: "Return the full provenance chain for a fact (events, anchor, gate, edges).",
    inputSchema: s({ fact_id: nonEmptyStr }, ["fact_id"]),
    outputSchema: s({ fact: obj, error: str }),
    async handler(rt, args) {
      const a = whyInput.parse(args);
      const id = rt.resolveFactId(a.fact_id);
      const report = id ? rt.why(id) : null;
      return report ? redactWhyReport(report) : { error: "fact not found" };
    },
  },
  {
    name: "resolve_conflict",
    description: "Resolve disputed facts by precedence; returns winners + surfaced conflicts.",
    inputSchema: s({ session_id: str }),
    outputSchema: s({ winners: arr(str), conflicts: arr(obj) }, ["winners", "conflicts"]),
    async handler(rt, args) {
      const a = resolveInput.parse(args);
      const active = rt.facts.activeAsOf(rt.scope(a.session_id));
      const { resolved, conflicts } = resolveConflicts(
        active.map((f) => ({ fact: f, score: 1 })),
        a.session_id,
      );
      return { winners: resolved.map((r) => r.fact.fact_id), conflicts };
    },
  },
];

function refreshAgentsCapsule(rt: Runtime): void {
  try {
    writeAgentsCapsule(rt);
  } catch {
    // MCP memory writes should not fail just because the static floor cannot refresh.
  }
}
