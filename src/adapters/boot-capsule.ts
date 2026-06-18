import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isoNow } from "../core/clock.js";
import type { Capsule, Fact } from "../core/types.js";
import { renderCard } from "../render/cards.js";
import type { Runtime } from "../runtime.js";
import { containsSecret } from "../security/secrets.js";
import { AGENTS_BEGIN, AGENTS_END, renderAgentsCapsule } from "./claude-code/templates/agents.js";
import { assertWritableConfigPath } from "./config-path.js";

const DEFAULT_FACT_LIMIT = 12;

export function writeAgentsCapsule(rt: Runtime, opts: { limit?: number } = {}): string {
  const facts = factsForAgentsCapsule(rt, opts.limit ?? DEFAULT_FACT_LIMIT);
  return writeAgentsCapsuleFacts(rt.workspaceDir, facts);
}

export function writeAgentsCapsuleFacts(
  workspaceDir: string,
  facts: string[],
  generatedAt = isoNow(),
): string {
  const capsule = renderAgentsCapsule({
    facts: facts.filter((f) => !containsSecret(f)),
    generatedAt,
  });
  const path = join(workspaceDir, "AGENTS.md");
  assertWritableConfigPath(path, "AGENTS.md boot capsule file");
  let content = `${capsule}\n`;

  if (existsSync(path)) {
    content = mergeAgentsCapsule(readFileSync(path, "utf8"), capsule);
  }

  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(path, content, "utf8");
  return path;
}

export function factsForAgentsCapsule(rt: Runtime, limit = DEFAULT_FACT_LIMIT): string[] {
  return rt.facts
    .activeAsOf({ user_id: rt.userId, workspace_id: rt.workspaceId })
    .filter((f) => !f.scope.session_id && f.trust_tier === "high" && f.sensitivity !== "secret")
    .sort(compareBootFacts)
    .slice(0, limit)
    .map((f) =>
      renderCard(f)
        .markdown.replace(/^- /, "")
        .replace(/\s*\[mem:[^\]]+\]$/, ""),
    );
}

export function factsFromCapsule(capsule: Capsule): string[] {
  return capsule.markdown
    .split("\n")
    .filter((l) => l.trim().startsWith("-"))
    .map((l) => l.replace(/^- /, "").replace(/\s*\[mem:[^\]]+\]$/, ""))
    .filter((l) => l.trim().length > 0 && !containsSecret(l));
}

export function mergeAgentsCapsule(existing: string, capsule: string): string {
  if (existing.includes(AGENTS_BEGIN) && existing.includes(AGENTS_END)) {
    return existing.replace(
      new RegExp(`${escapeRe(AGENTS_BEGIN)}[\\s\\S]*${escapeRe(AGENTS_END)}`),
      capsule,
    );
  }
  return `${existing.trimEnd()}\n\n${capsule}\n`;
}

function compareBootFacts(a: Fact, b: Fact): number {
  const byPriority = bootFactPriority(b) - bootFactPriority(a);
  if (byPriority !== 0) return byPriority;
  const byRecorded = Date.parse(b.time.t_recorded) - Date.parse(a.time.t_recorded);
  if (byRecorded !== 0) return byRecorded;
  return a.fact_id.localeCompare(b.fact_id);
}

function bootFactPriority(f: Fact): number {
  if (f.fact_kind === "open_loop") return 4;
  if (f.tags.includes("user_explicit") || f.tags.includes("mcp_remember")) return 3;
  if (f.source.asserted_by === "user") return 2;
  if (f.source.asserted_by === "deterministic_parser") return 1;
  return 0;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
