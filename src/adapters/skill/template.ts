// Canonical graphCTX agent-skill template. Rendered into a per-client folder by
// the `graphctx skill <client>` command. The content is identical across
// clients; only the destination path varies. Markdown is intentionally small
// (LLM context budget) and mentions ONLY surface area that exists today.

export interface SkillTemplateOptions {
  binPath?: string; // command used to invoke graphctx (defaults to "graphctx")
}

export function renderSkillMarkdown(opts: SkillTemplateOptions = {}): string {
  const bin = opts.binPath ?? "graphctx";
  return [
    "---",
    "name: graphctx",
    "description: Local-first persistent memory for this project. Use it whenever you need",
    "  durable knowledge across turns or sessions.",
    "---",
    "",
    "# graphCTX skill",
    "",
    "## When to use",
    "- At the start of any non-trivial task, call `recall` with the user request.",
    '- When the user states a fact ("we use pnpm", "deploy is ./ship.sh"), call',
    "  `remember` with the verbatim claim.",
    "- When two stored facts conflict, call `resolve_conflict`.",
    "- Treat any `[mem:*]` block already in your context as authoritative.",
    "",
    "## Tools (MCP server: graphctx)",
    "- remember(text, kind?, scope?)",
    "- recall(query, budget_tokens?)",
    "- inject_context(event, session_id?, user_prompt?)",
    "- checkpoint_session(session_id?)",
    "- promote(session_id?, dry_run?)",
    "- forget(fact_id, reason?)",
    "- why(fact_id)",
    "- resolve_conflict(session_id?)",
    "",
    "## Setup once per repo",
    "```",
    `${bin} init -C .`,
    `${bin} install auto -C .`,
    `${bin} doctor -C .`,
    "```",
    "",
    "## Notes",
    "- 100% local. No network is required at runtime.",
    "- Facts are commit-valid: graphCTX automatically suppresses facts whose",
    "  git anchor is no longer in the current branch.",
    "",
  ].join("\n");
}
