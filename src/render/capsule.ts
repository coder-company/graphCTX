import type { Capsule, ConflictNote, Event } from "../core/types.js";
import type { CardSection, RenderedCard } from "./cards.js";
import { estimateTokens } from "./tokens.js";

const SECTION_ORDER: CardSection[] = [
  "open_loops",
  "task_state",
  "repo_constraints",
  "procedure",
  "user_preferences",
  "conflict_notes",
];

const SECTION_TITLE: Record<CardSection, string> = {
  open_loops: "Open loops / unfinished work",
  task_state: "Task state",
  repo_constraints: "Repo constraints",
  procedure: "Applicable procedure",
  user_preferences: "User preferences",
  conflict_notes: "Conflict notes",
};

const HEADER: Record<string, string> = {
  PostCompact: "Restored memory after compaction (graphCTX)",
  SessionStart: "Relevant memory for this session (graphCTX)",
};

// Assemble the markdown capsule with fixed section order (SPEC §16).
export function renderCapsule(
  event: Event,
  cards: RenderedCard[],
  conflicts: ConflictNote[],
  omitted: Array<{ fact_id: string; reason: string }> = [],
): Capsule {
  const bySection = new Map<CardSection, RenderedCard[]>();
  for (const c of cards) {
    const arr = bySection.get(c.section) ?? [];
    arr.push(c);
    bySection.set(c.section, arr);
  }

  const lines: string[] = [];
  lines.push(`## ${HEADER[event] ?? "Relevant memory (graphCTX)"}`);
  lines.push("");

  for (const section of SECTION_ORDER) {
    if (section === "conflict_notes") continue;
    const arr = bySection.get(section);
    if (!arr || arr.length === 0) continue;
    lines.push(`**${SECTION_TITLE[section]}:**`);
    for (const c of arr) lines.push(c.markdown);
    lines.push("");
  }

  if (conflicts.length > 0) {
    lines.push(`**${SECTION_TITLE.conflict_notes}:**`);
    for (const c of conflicts) lines.push(`- ${c.summary} [conflict:${c.conflict_id}]`);
    lines.push("");
  }

  const markdown = lines.join("\n").trimEnd();
  return {
    markdown,
    cards: cards.map((c) => ({ fact_id: c.fact_id, reason: c.section, tokens: c.tokens })),
    omitted,
    conflicts,
    token_count: estimateTokens(markdown),
  };
}

export const EMPTY_CAPSULE: Capsule = {
  markdown: "",
  cards: [],
  omitted: [],
  conflicts: [],
  token_count: 0,
};
