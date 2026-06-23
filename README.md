<div align="center">

# graphCTX

**Local-first memory for coding agents.**

Lifecycle-hook *push* for commit-valid, scope-aware context in Claude Code, plus
refreshed static grounding and MCP/recall fallback for Cursor, OpenCode, and
generic clients.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?logo=typescript&logoColor=white)](tsconfig.json)
[![Tests](https://img.shields.io/badge/tests-vitest-6E9F18?logo=vitest&logoColor=white)](vitest.config.ts)
[![Lint](https://img.shields.io/badge/lint-biome-60a5fa?logo=biome&logoColor=white)](biome.json)
[![MCP](https://img.shields.io/badge/MCP-stdio%20server-8b5cf6)](src/adapters)
[![Local-first](https://img.shields.io/badge/local--first-no%20cloud%20required-22c55e)](#design-notes)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-ff69b4.svg)](CONTRIBUTING.md)

</div>

---

> **Using this from an AI agent?** Start with [AGENT_USAGE.md](AGENT_USAGE.md).
> It covers install, MCP server setup for every major client (Claude Code,
> Cursor, OpenCode, Codex, Claude Desktop, Zed, Continue, etc.), how to add
> graphCTX as a skill, and the 8 MCP tools with examples.

## Why graphCTX

Coding agents forget. Compaction strips context, branches mutate truth, and
"recall" only works when the model remembers to ask. graphCTX flips the model:
it *pushes* commit-valid memory at the right lifecycle moments, and falls back
to pull-based MCP recall where push is not available.

Everything runs on your machine. The CLI, embedded SQLite store, git anchoring,
eval harness, benchmarks, and MCP stdio server work fully offline. There is no
required web service and no required network call for normal operation.

## Features

- **Commit-valid fact store** over SQLite with migrations, WAL, FTS, optional
  `sqlite-vec`, provenance edges, and append-only audit records.
- **Hybrid retrieval** with lexical, semantic, RRF, MMR diversity, scope and
  entity signals, and commit-valid filtering.
- **Injection planner** with lifecycle gate, token budgeting, anti-repetition
  ledger, open-loop resurfacing, send-edge security checks, and provenance
  tags.
- **Multi-client adapters** for Claude Code (lifecycle push), Cursor, OpenCode,
  generic clients, and proxy channel fallback for refreshed grounding plus MCP
  recall.
- **MCP stdio server** exposing exactly 8 tools: `remember`, `recall`,
  `inject_context`, `checkpoint_session`, `promote`, `forget`, `why`,
  `resolve_conflict`.
- **Deterministic offline eval suite** with benchmark gates covering memory,
  retrieval, relevance, security, temporal validity, conflicts, LLM extraction,
  promotion, adapters, MCP, storage, telemetry, provenance, resilience, docs,
  demo, and code quality.

## Install

One-liner. Downloads a single self-contained binary for your platform (Linux
or macOS, x64 or arm64). No Node, no Bun, no account, no API key. The binary
bundles SQLite and the vector index, and no data leaves your machine.

```bash
curl -fsSL https://graph.coder.company/install | sh
```

Environment overrides:

- `GRAPHCTX_INSTALL_DIR` &mdash; install location (default: `$HOME/.local/bin`).
- `GRAPHCTX_RELEASE` &mdash; pin to a specific release tag.

Verify:

```bash
graphctx --version
```

### From source (development)

Requires **Node.js 20+**.

```bash
git clone https://github.com/coder-company/graphCTX.git
cd graphCTX
npm install
npx tsx src/cli.ts --help
```

Compile the package when you need a build:

```bash
npm run build
```

For local CLI development either use `npx tsx src/cli.ts ...` directly or drop
a `graphctx` shim on your `PATH`:

```bash
printf '#!/usr/bin/env bash\nexec npx tsx %s/src/cli.ts "$@"\n' "$PWD" > ~/.local/bin/graphctx
chmod +x ~/.local/bin/graphctx
```

## Core Workflow

Initialize a repo, install the adapter, and inspect readiness:

```bash
graphctx init -C .
graphctx install auto -C .
graphctx doctor -C .
```

Store and retrieve explicit memory:

```bash
graphctx remember "deploy with ./scripts/ship.sh" -C .
graphctx recall   "how do I deploy this project"  -C .
graphctx why      <fact_id_or_last8>              -C .
```

Carry unfinished work across compaction:

```bash
graphctx loop    "finish the retry backoff"  -C .
graphctx hook    PostCompact -C . < payload.json
graphctx resolve <fact_id_or_last8> -C .
```

Run extraction and the offline demo:

```bash
graphctx extract -C .
graphctx demo
```

## CLI Reference

Core installed commands are discoverable with `graphctx --help`:

```bash
graphctx init
graphctx install   <claude|cursor|opencode|generic|auto>
graphctx uninstall <claude|cursor|opencode|generic>
graphctx hook      <event>
graphctx recall    "<query>"
graphctx remember  "<text>"
graphctx loop      "<text>"
graphctx resolve   <fact_id_or_last8>
graphctx extract
graphctx serve     --mcp
graphctx why       <fact_id_or_last8>
graphctx doctor
graphctx demo
graphctx skill   <claude|cursor|opencode|codex|generic|all>
graphctx tui
```

Development-checkout gates:

```bash
npx tsx src/cli.ts eval all
npx tsx src/cli.ts eval quality
npx tsx src/cli.ts eval cli-docs-demo
npx tsx src/cli.ts eval mcp
npx tsx src/cli.ts eval run --arms A,B,C,N,S
npx tsx src/cli.ts bench
```

The development-only command names are still exposed by the CLI for repo
checkouts: `graphctx eval <suite|all>`, `graphctx bench`, and
`graphctx compare`.

## Repository Layout

```
.
├── src/          # TypeScript source (CLI, store, retrieval, adapters, MCP)
├── test/         # Vitest unit/integration suites
├── fixtures/     # Repo fixtures used by extractors and eval arms
├── scripts/      # Build, packaging, and pack-smoke helpers
├── docs/         # Spec, gameplan, PRD, status, notes
├── DEMO.md       # ~3 minute live demo walkthrough
└── README.md
```

## Testing and Quality Gates

Run the same green bar used by the development mission:

```bash
npx tsc --noEmit
npx biome check src test
npx biome check .
npx vitest run
npm  run   pack:smoke
npx tsx src/cli.ts eval all
npx tsx src/cli.ts bench
```

Expected current state:

- `npx vitest run`: 292 tests pass.
- `npm run pack:smoke`: packed tarball installs, runs the demo, and serves
  MCP from a clean temp app.
- `npx tsx src/cli.ts eval all`: 19 gate suites pass.
- `npx tsx src/cli.ts bench`: hook hot-path p95 below 150ms.

## Design Notes

graphCTX is deliberately local-first. Missing LLM keys, missing git metadata,
bad config, or corrupt stores degrade to *no memory* rather than a broken
agent. Live LLM extraction is opt-in: deterministic extraction and all default
gates run offline. Provider-backed extraction uses bounded, cancellable
requests and fails soft to deterministic-only behavior.

The product thesis is measured by the offline ablation:

```bash
graphctx eval run --arms A,B,C,N,S
```

Arm C (lifecycle push) must beat arm B (pull-only recall), while the N/S
controls prove graphCTX can deliver a memory-only fact and suppress stale
facts.

## For AI agents

If you are an AI agent (Claude Code, Cursor, OpenCode, Codex, Claude Desktop,
Zed, Continue, a custom MCP client, etc.) read [AGENT_USAGE.md](AGENT_USAGE.md).
It is the single source of truth for:

- how to install graphCTX
- how to add the MCP server (per-client snippets)
- how to wire lifecycle hooks
- how to register graphCTX as a skill
- the 8 MCP tools and when to call each
- troubleshooting

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md)
for development setup, the local green-bar checklist, and the conventions used
by this repository. To report a security issue privately, see
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) (c) coder-company
