import { z } from "zod";
import { writeAgentsCapsule } from "../adapters/boot-capsule.js";
import { type Event, FACT_KINDS, type Fact, type ScoredFact } from "../core/types.js";
import { redactWhyReport } from "../provenance/why.js";
import { resolveConflicts } from "../resolve/conflicts.js";
import type { Runtime } from "../runtime.js";
import { assertSafeExplicitMemoryWrite } from "../security/intake.js";
import { sanitizeRetrievalText } from "../security/retrieval-context.js";

// The EXACTLY 8 MCP tools (SPEC §18, I8). One handler each; each validates input
// with zod and returns structured output. The MCP server enforces the count.
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema for tools/list
  outputSchema: Record<string, unknown>; // JSON Schema for successful structuredContent
  handler: (rt: Runtime, args: unknown) => Promise<unknown>;
}

const factKindValues = FACT_KINDS;

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
      assertSafeExplicitMemoryWrite({
        text: a.text,
        subject: a.subject,
        predicate: a.predicate,
        kind: a.kind,
        session_id: a.session_id,
      });
      const fact = await rt.rememberFact({
        text: a.text,
        subject: a.subject,
        predicate: a.predicate,
        kind: a.kind,
        sessionId: a.session_id,
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
      assertSafeSessionReference(a.session_id);
      const ctx = await rt.injectionContext("UserPromptSubmit", a.session_id ?? "mcp-session", {
        user_prompt: sanitizeRetrievalText(a.query),
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
      assertSafeSessionReference(a.session_id);
      const ctx = await rt.injectionContext(a.event, a.session_id, {
        user_prompt: sanitizeRetrievalText(a.user_prompt),
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
      assertSafeSessionReference(a.session_id);
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
      assertSafeSessionReference(a.session_id);
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
      await rt.forgetFact(id);
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
      assertSafeSessionReference(a.session_id);
      const { resolved, conflicts } = resolveConflicts(
        conflictCandidates(rt, a.session_id),
        a.session_id,
      );
      return { winners: resolved.map((r) => r.fact.fact_id), conflicts };
    },
  },
];

function conflictCandidates(rt: Runtime, sessionId?: string): ScoredFact[] {
  const byId = new Map<string, Fact>();
  const add = (facts: Fact[]) => {
    for (const fact of facts) byId.set(fact.fact_id, fact);
  };
  add(rt.facts.userScopedActive(rt.userId));
  add(
    rt.facts
      .activeAsOf({ user_id: rt.userId, workspace_id: rt.workspaceId })
      .filter((fact) => !fact.scope.session_id),
  );
  if (sessionId) add(rt.facts.activeAsOf(rt.scope(sessionId)));
  return [...byId.values()].map((fact) => ({ fact, score: 1 }));
}

function assertSafeSessionReference(sessionId: string | undefined): void {
  assertSafeExplicitMemoryWrite({ text: "session reference", session_id: sessionId });
}

function refreshAgentsCapsule(rt: Runtime): void {
  try {
    writeAgentsCapsule(rt);
  } catch {
    // MCP memory writes should not fail just because the static floor cannot refresh.
  }
}
