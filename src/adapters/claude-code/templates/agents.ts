// AGENTS.md boot-capsule template (Tier 0 floor, SPEC §17). Static grounding +
// a recall directive. Not the answer — the hooks (Tier 2) carry the live push.
export function renderAgentsCapsule(opts: {
  facts: string[];
  generatedAt: string;
}): string {
  const bullets = opts.facts.length
    ? opts.facts.map((f) => `- ${f}`).join("\n")
    : "- (no durable facts extracted yet)";
  return `<!-- graphctx:begin -->
## graphCTX memory (boot grounding)

This project is tracked by **graphCTX** — a local-first memory layer that pushes
commit-valid context at lifecycle moments. The durable facts below are grounding;
live recall is pushed automatically at SessionStart and after compaction.

**Known durable facts (as of ${opts.generatedAt}):**
${bullets}

> If you need more, you may call the \`recall\` tool — but graphCTX will also push
> the relevant memory to you proactively, so you should not need to ask.
<!-- graphctx:end -->`;
}

export const AGENTS_BEGIN = "<!-- graphctx:begin -->";
export const AGENTS_END = "<!-- graphctx:end -->";
