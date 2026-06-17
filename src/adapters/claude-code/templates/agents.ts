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

This project is tracked by **graphCTX** — a local-first memory layer for
commit-valid project context. The durable facts below are static grounding;
Claude Code hooks can push fresher context at lifecycle moments, while MCP
clients can call recall for live memory.

**Known durable facts (as of ${opts.generatedAt}):**
${bullets}

> If you need more, call the \`recall\` tool. Claude Code hook installs also
> receive lifecycle push context automatically.
<!-- graphctx:end -->`;
}

export const AGENTS_BEGIN = "<!-- graphctx:begin -->";
export const AGENTS_END = "<!-- graphctx:end -->";
