import { z } from "zod";
import { resolveConflicts } from "../resolve/conflicts.js";
import type { Runtime } from "../runtime.js";

// The EXACTLY 8 MCP tools (SPEC §18, I8). One handler each; each validates input
// with zod and returns structured output. The MCP server enforces the count.
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema for tools/list
  handler: (rt: Runtime, args: unknown) => Promise<unknown>;
}

const rememberInput = z.object({
  text: z.string().min(1),
  kind: z
    .enum([
      "semantic",
      "procedural",
      "preference",
      "decision",
      "constraint",
      "failure",
      "task_state",
      "open_loop",
    ])
    .default("semantic"),
  subject: z.string().default("user"),
  predicate: z.string().default("note"),
  session_id: z.string().optional(),
});

const recallInput = z.object({
  query: z.string().min(1),
  budget_tokens: z.number().int().positive().optional(),
  session_id: z.string().optional(),
});

const injectInput = z.object({
  event: z.string().default("UserPromptSubmit"),
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
const bool = { type: "boolean" };

export const MCP_TOOLS: McpTool[] = [
  {
    name: "remember",
    description: "Store a fact/event/procedure candidate in graphCTX memory.",
    inputSchema: s({ text: str, kind: str, subject: str, predicate: str, session_id: str }, [
      "text",
    ]),
    async handler(rt, args) {
      const a = rememberInput.parse(args);
      const fact = await rt.learn({
        subject: a.subject,
        predicate: a.predicate,
        object: a.text,
        fact_kind: a.kind,
        temporal_kind: a.kind === "task_state" || a.kind === "open_loop" ? "dynamic" : "static",
        scope: rt.scope(a.session_id),
        trust_tier: "high", // user-asserted via explicit tool call
        status: "candidate",
        promotion_state: "session_only",
        source: { asserted_by: "user", event_ids: [], raw_quote: a.text },
        tags: ["mcp_remember"],
      });
      return { fact_id: fact.fact_id, status: fact.status };
    },
  },
  {
    name: "recall",
    description: "Pull retrieval (fallback path; push is primary). Returns ranked memory cards.",
    inputSchema: s({ query: str, budget_tokens: num, session_id: str }, ["query"]),
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
    inputSchema: s({ event: str, session_id: str, user_prompt: str }),
    async handler(rt, args) {
      const a = injectInput.parse(args);
      const ctx = await rt.injectionContext(a.event as never, a.session_id, {
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
    async handler(rt, args) {
      const a = checkpointInput.parse(args);
      const swept = await rt.runPromotionSweep(a.session_id);
      return { promoted: swept };
    },
  },
  {
    name: "promote",
    description: "Run the session→workspace promotion sweep (dry-run supported).",
    inputSchema: s({ session_id: str, dry_run: bool }),
    async handler(rt, args) {
      const a = promoteInput.parse(args);
      if (a.dry_run) {
        const candidates = rt.facts.candidates(rt.scope(a.session_id));
        return { dry_run: true, candidate_count: candidates.length };
      }
      const swept = await rt.runPromotionSweep(a.session_id);
      return { promoted: swept };
    },
  },
  {
    name: "forget",
    description: "Expire a fact so it stops being recalled/injected.",
    inputSchema: s({ fact_id: str, reason: str }, ["fact_id"]),
    async handler(rt, args) {
      const a = forgetInput.parse(args);
      rt.facts.expire(a.fact_id, `forget:${a.reason}`);
      return { fact_id: a.fact_id, status: "expired" };
    },
  },
  {
    name: "why",
    description: "Return the full provenance chain for a fact (events, anchor, gate, edges).",
    inputSchema: s({ fact_id: str }, ["fact_id"]),
    async handler(rt, args) {
      const a = whyInput.parse(args);
      const report = rt.why(a.fact_id);
      return report ?? { error: "fact not found" };
    },
  },
  {
    name: "resolve_conflict",
    description: "Resolve disputed facts by precedence; returns winners + surfaced conflicts.",
    inputSchema: s({ session_id: str }),
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
