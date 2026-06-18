# graphCTX

Local-first memory for coding agents. graphCTX gives Claude Code lifecycle-hook
push for commit-valid, scope-aware context, and gives Cursor, OpenCode, and
generic clients refreshed static grounding plus MCP/recall fallback.

Everything runs on your machine: CLI, embedded SQLite, git anchoring, eval
harness, benchmarks, and MCP stdio server. There is no required web service and
no required network call for normal operation.

## What Is Built

- Commit-valid fact store over SQLite with migrations, WAL, FTS, optional
  sqlite-vec, provenance edges, and append-only audit records.
- Hybrid retrieval with lexical, semantic, RRF, MMR diversity, scope/entity
  signals, and commit-valid filtering.
- Injection planner with lifecycle gate, token budgeting, anti-repetition
  ledger, open-loop resurfacing, send-edge security checks, and provenance tags.
- Claude Code hook adapter for lifecycle push, plus Cursor, OpenCode, generic,
  and proxy channel ladder support for static grounding and MCP/recall fallback.
- MCP stdio server exposing exactly 8 tools:
  `remember`, `recall`, `inject_context`, `checkpoint_session`, `promote`,
  `forget`, `why`, `resolve_conflict`.
- Deterministic offline eval suite battery and benchmark gates covering memory,
  retrieval, relevance, security, temporal validity, conflicts, LLM extraction,
  promotion, adapters/MCP, storage, telemetry, provenance, resilience, docs/demo,
  and code quality.

## Setup

```bash
npm install
npx tsx src/cli.ts --help
```

Build the TypeScript package when you need compiled output:

```bash
npm run build
```

For local CLI development, either use `npx tsx src/cli.ts ...` directly or put a
shim named `graphctx` on your PATH:

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
graphctx recall "how do I deploy this project" -C .
graphctx why <fact_id_or_last8> -C .
```

Carry unfinished work across compaction:

```bash
graphctx loop "finish the retry backoff" -C .
graphctx hook PostCompact -C . < payload.json
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
graphctx install <claude|cursor|opencode|generic|auto>
graphctx uninstall <claude|cursor|opencode|generic>
graphctx hook <event>
graphctx recall "<query>"
graphctx remember "<text>"
graphctx loop "<text>"
graphctx resolve <fact_id_or_last8>
graphctx extract
graphctx serve --mcp
graphctx why <fact_id_or_last8>
graphctx doctor
graphctx demo
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
checkouts: `graphctx eval <suite|all>`, `graphctx bench`, and `graphctx compare`.

## Testing And Quality Gates

Run the same green bar used by the mission:

```bash
npx tsc --noEmit
npx biome check src test
npx biome check .
npx vitest run
npm run pack:smoke
npx tsx src/cli.ts eval all
npx tsx src/cli.ts bench
```

Expected current state:

- `npx vitest run`: 271 tests pass.
- `npm run pack:smoke`: packed tarball installs, runs the demo, and serves MCP from a clean temp app.
- `npx tsx src/cli.ts eval all`: 19 gate suites pass.
- `npx tsx src/cli.ts bench`: hook hot-path p95 is below 150ms.

## Design Notes

graphCTX is deliberately local-first. Missing LLM keys, missing git metadata,
bad config, or corrupt stores degrade to no memory rather than a broken agent.
Live LLM extraction is opt-in; deterministic extraction and all default gates run
offline. Provider-backed extraction uses bounded, cancellable requests and fails
soft to deterministic-only behavior.

The product thesis is measured by the offline ablation:

```bash
graphctx eval run --arms A,B,C,N,S
```

Arm C, lifecycle push, must beat arm B, pull-only recall, while the N/S controls
prove graphCTX can deliver a memory-only fact and suppress stale facts.

## License

MIT (c) coder-company
