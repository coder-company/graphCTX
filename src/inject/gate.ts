import type { Event, InjectionContext } from "../core/types.js";

export interface GateConfig {
  enabledEvents: string[];
  driftThreshold: number;
}

// Optional drift signal computed by the planner from episode embeddings. When
// absent (no vector index / no history) the gate falls back to entity-change so
// it always degrades gracefully (I9).
export interface DriftSignal {
  // cosine distance of the current prompt from the rolling task centroid (0..2)
  centroidDistance?: number;
  // entities mentioned now that were not seen in the recent window
  hasNewEntities?: boolean;
}

// Relevance gate (SPEC §15, GAMEPLAN §5.2) — the invention. Decides WHETHER to
// fire at a deterministic moment so we don't poison context by injecting on
// everything.
//
//  - SessionStart / PostCompact  → ALWAYS fire (beachhead, empty space to fill).
//  - UserPromptSubmit            → fire on topic-centroid DRIFT or NEW entities.
//  - PreToolUse                  → fire only if memory plausibly applies to the
//                                  planned tool/args (selective — proven by the
//                                  gate-firing-rate test).
//  - PostToolUse                 → fire only on FAILURE (recovery hand-off).
export function shouldFire(ctx: InjectionContext, cfg: GateConfig, drift?: DriftSignal): boolean {
  if (!cfg.enabledEvents.includes(ctx.event)) return false;

  switch (ctx.event) {
    case "SessionStart":
    case "PostCompact":
      return true; // always fire — beachhead (D12)
    case "UserPromptSubmit":
      return driftedOrNewEntities(ctx, cfg, drift);
    case "PreToolUse":
      return planPlausiblyHasMemory(ctx);
    case "PostToolUse":
      return ctx.tool_result?.success === false;
    default:
      return false;
  }
}

function driftedOrNewEntities(
  ctx: InjectionContext,
  cfg: GateConfig,
  drift?: DriftSignal,
): boolean {
  // Primary signal: topic-centroid drift past the configured threshold.
  if (drift?.centroidDistance !== undefined) {
    if (drift.centroidDistance > cfg.driftThreshold) return true;
  }
  // Secondary signal: explicit new entities computed against the recent window.
  if (drift?.hasNewEntities) return true;
  // Fallback (no drift signal available): any entities present in this turn.
  if (drift === undefined) return hasAnyEntities(ctx);
  return false;
}

function hasAnyEntities(ctx: InjectionContext): boolean {
  return (ctx.current_files?.length ?? 0) + (ctx.mentioned_symbols?.length ?? 0) > 0;
}

// PreToolUse selectivity: Bash with a command family we may have facts or
// guardrails about, or an Edit/Write touching a path that may carry constraints.
// NOT every tool call.
function planPlausiblyHasMemory(ctx: InjectionContext): boolean {
  const name = ctx.planned_tool?.name?.toLowerCase() ?? "";
  if (!name) return false;
  const isBash = name.includes("bash") || name.includes("shell") || name.includes("run");
  const isEdit = name.includes("edit") || name.includes("write") || name.includes("create");
  if (!isBash && !isEdit) return false;
  // Require some concrete handle in the args so we don't fire on empty tool use.
  const args = ctx.planned_tool?.args ? JSON.stringify(ctx.planned_tool.args) : "";
  if (isEdit) return args.length > 2 || (ctx.current_files?.length ?? 0) > 0;
  return shellCommandLikelyUsesMemory(args);
}

function shellCommandLikelyUsesMemory(argsJson: string): boolean {
  if (argsJson.length <= 2) return false;
  const args = argsJson.toLowerCase();
  return (
    /\b(npm|pnpm|yarn|bun|node|tsx|tsc|vitest|jest|mocha|uv|poetry|pip|pytest|tox|nox|hatch|ruff|mypy|pyright|biome|eslint|prettier|cargo|go\s+test|make|cmake|docker|docker-compose|git)\b/.test(
      args,
    ) || /\b(rm|mv|cp|chmod|chown|ln)\b/.test(args)
  );
}

export const ALWAYS_FIRE_EVENTS: Event[] = ["SessionStart", "PostCompact"];

// Cosine distance (1 - cosine similarity) between two L2-normalized vectors.
// Used by the planner to compute centroid drift. Defensive against length
// mismatch / zero vectors (returns max distance so the gate fires on garbage).
export function cosineDistance(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  if (na === 0 || nb === 0) return 1;
  const cos = dot / (Math.sqrt(na) * Math.sqrt(nb));
  return 1 - cos;
}

// Rolling task centroid from a window of recent text embeddings (mean, then
// re-normalized). Returns null when there is nothing to average.
export function taskCentroid(vectors: Float32Array[]): Float32Array | null {
  if (vectors.length === 0) return null;
  const dim = vectors[0]!.length;
  const out = new Float32Array(dim);
  for (const v of vectors) {
    for (let i = 0; i < dim; i++) out[i] = (out[i] ?? 0) + (v[i] ?? 0);
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    out[i] = (out[i] ?? 0) / vectors.length;
    norm += out[i]! * out[i]!;
  }
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dim; i++) out[i] = out[i]! / norm;
  return out;
}
