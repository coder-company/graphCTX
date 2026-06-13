# graphCTX

> **Local-first memory for coding agents. Dev tooling, not a SaaS.**
> graphCTX *pushes* commit-valid, scope-aware context into your AI coding agent at the exact moments it drifts — so the agent stops being a goldfish. Everything runs on your machine. Your code never leaves it.

[![status](https://img.shields.io/badge/status-pre--MVP-orange)](docs/PRD.md)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## Why local-first is the point (not a limitation)

The whole workflow already lives on your machine: your repo, your agent, your context window. A server adds nothing to the core loop — it would only add latency and ship your proprietary code somewhere. graphCTX belongs in the same category as `git`, your LSP, ESLint, and Claude Code's own hooks: **tooling that sits in your loop, not a service that phones home.**

The value was never "we host your data." The value is the **injection loop** — forcing the right context into the agent when it drifts. That is 100% local.

> Cloud sync, teams, and remote MCP are *optional future upsells* (multi-device, collaboration, zero-install) — explicitly **not** part of the core product and not needed to be useful. See [docs/future/INFRASTRUCTURE.md](docs/future/INFRASTRUCTURE.md). They are out of scope until the local product is proven.

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

TypeScript · SQLite (WAL + FTS5 + vectors) · MCP · Claude Code hooks first, channel ladder for other clients. **Local-first, private by default, no external database, no network required.**

## License

MIT © coder-company
