# graphCTX

> **A local-first memory control plane for coding agents.**
> graphCTX *pushes* commit-valid, scope-aware context into AI coding agents at the exact lifecycle moments where they drift — instead of hoping the model remembers to ask.

[![status](https://img.shields.io/badge/status-pre--MVP-orange)](docs/PRD.md)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## The problem

AI coding agents forget. Within a session they drift after context compaction; across sessions they start from zero — re-learning the test command, the architecture, the conventions, and your preferences every time.

The industry answer is *memory you pull*: a tool the model calls when it decides to. But MCP tools are **model-controlled**, so recall becomes a **compliance problem** — the agent forgets to ask exactly when it most needs to remember.

## The idea

graphCTX inverts this. It is a memory layer that **pushes** the right context into the agent at deterministic lifecycle moments (session start, post-compaction, before a tool call, on branch switch), backed by a **commit-anchored temporal store** so facts are valid *as of a git state*, not wall-clock time.

Memory lives in three scopes with conservative, evidence-gated promotion between them:

| Scope | Holds | Lifetime |
|---|---|---|
| **Session** | Working state: plan, failed attempts, task state | Ephemeral |
| **Workspace** | Durable repo truth: commands, conventions, architecture (commit-anchored) | Per project |
| **User** | Cross-project preferences & habits (static + dynamic) | Follows the user |

> The winning product is not the graph. It's the **injection loop + promotion discipline**.

## Status

Pre-MVP. The full design lives in **[docs/PRD.md](docs/PRD.md)**.

The first thing we validate (M0): **does pushed context beat pulled context** on real coding tasks with forced compaction? If not, the thesis is wrong — and we learn it cheaply.

## Planned interface

```
graphctx init                 # set up store + write AGENTS.md capsule
graphctx serve --mcp          # run the MCP server
graphctx install claude       # install push adapter (hooks)
graphctx recall "<query>"     # pull fallback (not the primary path)
graphctx inject --event PostCompact --session <id>
graphctx time-travel --commit <sha> recall "<query>"
graphctx why fact <id>        # provenance
```

## Tech

TypeScript · SQLite (WAL + FTS5 + vectors) · MCP · Claude Code hooks first, channel ladder for other clients. Local-first, private by default, no external database.

## License

MIT © coder-company
