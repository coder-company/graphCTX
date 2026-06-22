# Using graphCTX from an AI agent

This file is the single source of truth for **how an AI coding agent (Claude
Code, Cursor, OpenCode, Codex CLI, OpenAI Agents SDK, LangGraph, custom MCP
clients, etc.) actually wires up and uses graphCTX**.

If you only read one section, read [Quick start (60 seconds)](#quick-start-60-seconds).

---

## What graphCTX gives the agent

- **Persistent, commit-valid memory** stored locally in SQLite. Survives
  compaction, branch switches, and process restarts.
- **An MCP stdio server** with 8 tools the agent can call:
  `remember`, `recall`, `inject_context`, `checkpoint_session`, `promote`,
  `forget`, `why`, `resolve_conflict`.
- **Lifecycle "push"** for Claude Code: graphCTX injects fresh memory at
  `SessionStart` and `PostCompact` automatically. The agent does not have to
  remember to ask.
- **Static grounding** via an `AGENTS.md` boot capsule (read by Cursor,
  OpenCode, Codex, Claude Code, and any agent that respects `AGENTS.md`).

---

## Quick start (60 seconds)

```bash
# 1. Install the binary (no Node, no account, no API key)
curl -fsSL https://graph.coder.company/install | sh

# 2. cd into the project you want memory for
cd /path/to/your/repo

# 3. Initialize the store, extract facts, write AGENTS.md
graphctx init -C .

# 4. Wire whichever agent you use (auto-detects when possible)
graphctx install auto -C .

# 5. Verify the agent will see memory
graphctx doctor -C .
```

That is it. From the next agent session in this repo, memory is live.

If `install auto` cannot pick a client (no markers found), pick one explicitly
from the next section.

---

## Per-client setup

graphCTX writes the config files the agent already reads. You do not edit JSON
by hand. After `graphctx install <client>` the agent gets memory the next time
it starts a session in this directory.

### Claude Code (full lifecycle push)

```bash
graphctx install claude -C .          # workspace install (.claude/settings.json)
graphctx install claude -C . --global # user-level (~/.claude/settings.json)
```

What this does:

- Writes 7 hook entries into `.claude/settings.json` (`SessionStart`,
  `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `PostCompact`,
  `SessionEnd`).
- Each hook runs `graphctx hook <event>` with the event payload on stdin.
- On `SessionStart` / `PostCompact`, graphCTX pushes a memory capsule into the
  Claude conversation automatically. **You do not need a skill or prompt
  change.**

Verify: open a Claude Code session in this repo. You should see a `[mem:*]`
context block at the top of the first turn.

Uninstall:

```bash
graphctx uninstall claude -C .
```

### Cursor (rules + MCP)

```bash
graphctx install cursor -C .
```

What this does:

- Writes `.cursor/rules/graphctx.mdc` telling the model to call `recall` when
  unsure about project conventions, and to treat `[mem:*]` blocks as
  authoritative.
- Registers the MCP server in `.cursor/mcp.json`:

  ```json
  {
    "mcpServers": {
      "graphctx": { "command": "graphctx", "args": ["serve", "--mcp"] }
    }
  }
  ```

Restart Cursor (or reload the window). The MCP tools appear under "graphctx".

### OpenCode

```bash
graphctx install opencode -C .
```

What this does:

- Writes / merges `opencode.json` with:

  ```json
  {
    "mcp": {
      "graphctx": {
        "type": "local",
        "command": ["graphctx", "serve", "--mcp"],
        "enabled": true
      }
    }
  }
  ```

- Keeps `AGENTS.md` fresh as the Tier 0 grounding floor.

Restart OpenCode.

### Codex CLI / OpenAI Agents SDK / generic MCP client

```bash
graphctx install generic -C .
```

What this does:

- Writes the `AGENTS.md` boot capsule (every modern agent reads it).
- Marks the workspace as graphCTX-installed.

Then add the MCP server to your client by hand using the snippet below.

---

## Adding the MCP server manually (any client)

The server is just one command: `graphctx serve --mcp`. It speaks JSON-RPC over
stdio. Drop this entry into whatever config your agent uses:

```json
{
  "mcpServers": {
    "graphctx": {
      "command": "graphctx",
      "args": ["serve", "--mcp"]
    }
  }
}
```

Common locations:

| Client                  | File                                                   |
| ----------------------- | ------------------------------------------------------ |
| Claude Code (project)   | `.mcp.json` or `.claude/settings.json` `mcpServers`    |
| Claude Code (user)      | `~/.claude.json` `mcpServers`                          |
| Claude Desktop          | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Cursor (project)        | `.cursor/mcp.json`                                     |
| Cursor (user)           | `~/.cursor/mcp.json`                                   |
| OpenCode                | `opencode.json` `mcp.graphctx`                         |
| Codex CLI               | `~/.codex/mcp_servers.json`                            |
| Continue.dev            | `~/.continue/config.json` `mcpServers`                 |
| Zed                     | `~/.config/zed/settings.json` `context_servers`        |
| Any LangGraph / OpenAI Agents SDK | use the MCP transport pointing at the same command |

Verify with the official MCP inspector:

```bash
npx @modelcontextprotocol/inspector graphctx serve --mcp
```

You should see exactly 8 tools listed.

---

## The 8 MCP tools (what the agent actually calls)

| Tool                | Purpose                                                         |
| ------------------- | --------------------------------------------------------------- |
| `remember`          | Store a user-asserted fact, event, or procedure                 |
| `recall`            | Pull-based retrieval; returns ranked memory cards               |
| `inject_context`    | Build a fresh capsule for a lifecycle event                     |
| `checkpoint_session`| Persist session state (triggers promotion on session end)       |
| `promote`           | Run the session→workspace promotion sweep (supports `dry_run`)  |
| `forget`            | Expire a fact so it stops being recalled or injected            |
| `why`               | Return full provenance for a fact (events, anchor, gate, edges) |
| `resolve_conflict`  | Resolve disputed facts by precedence                            |

Example agent flow:

1. New session starts. graphCTX `inject_context` (or Claude Code hook) fires
   and the agent sees `[mem:deploy] ./scripts/ship.sh` in its context.
2. User asks something new. Agent calls `recall` with the user's prompt; gets
   ranked cards. Uses them inline.
3. Agent learns something durable ("we lint with biome, not eslint"). It calls
   `remember` with that text.
4. Session ends. `checkpoint_session` runs, durable session facts get promoted
   to the workspace store, transient ones drop.

---

## Adding graphCTX as a "skill"

graphCTX is not a skill itself; it is the substrate skills run on top of. But
if your harness has a skill system (Claude Code skills, Codex skills,
OpenCode skills, agent-autoresearch skills, etc.), drop this minimal skill
file into the skill directory and your agent will reach for `graphctx recall`
proactively.

`graphctx.skill.md` (or whatever your harness expects):

```markdown
---
name: graphctx
description: Local-first persistent memory for this project. Use it whenever
  you need durable knowledge across turns or sessions.
---

# graphCTX skill

## When to use
- At the start of any non-trivial task, call `recall` with the user request.
- When the user states a fact ("we use pnpm", "deploy is ./ship.sh"), call
  `remember` with the verbatim claim.
- When two stored facts conflict, call `resolve_conflict`.
- Treat any `[mem:*]` block already in your context as authoritative.

## Tools (MCP server: graphctx)
- remember(text, kind?, scope?, ttl?)
- recall(query, budget_tokens?)
- inject_context(event, session_id?, user_prompt?)
- checkpoint_session(session_id?)
- promote(session_id?, dry_run?)
- forget(fact_id, reason?)
- why(fact_id)
- resolve_conflict(session_id?)

## Setup once per repo
\`\`\`
graphctx init -C .
graphctx install auto -C .
graphctx doctor -C .
\`\`\`
```

For Claude Code skills, place at `.claude/skills/graphctx/SKILL.md`. For
OpenCode, `.opencode/skills/graphctx/SKILL.md`. For Codex,
`~/.codex/skills/graphctx/SKILL.md`.

---

## Day-to-day commands the agent (or the human) will use

```bash
# Store memory (kind defaults to "fact")
graphctx remember "deploy with ./scripts/ship.sh" -C .

# Pull-based recall (only needed without lifecycle push)
graphctx recall "how do I deploy this project" -C .

# Carry an unfinished item across compaction (open loop)
graphctx loop "finish the retry backoff" -C .

# Manually fire a hook (for debugging or non-Claude clients)
graphctx hook PostCompact -C . < payload.json

# Trace a fact's provenance
graphctx why <fact_id_or_last8> -C .

# Mark a stale fact as resolved/forget it
graphctx resolve <fact_id_or_last8> -C .
graphctx forget  <fact_id> -C .

# Re-run extraction over the repo (after big refactors)
graphctx extract -C .

# Start the MCP server in the foreground (for ad-hoc clients)
graphctx serve --mcp

# Health check
graphctx doctor -C .

# Interactive TUI
graphctx tui -C .

# Built-in demo (no setup needed)
graphctx demo
```

---

## How graphCTX decides what to inject

1. Lifecycle event fires (`SessionStart`, `PostCompact`, or an explicit
   `inject_context` MCP call).
2. Retrieval runs over the SQLite store: lexical FTS + optional `sqlite-vec`
   semantic vectors, fused with RRF, diversified with MMR, filtered by scope
   and commit validity.
3. The injection planner picks facts that fit the token budget, deduplicates
   against an anti-repetition ledger, surfaces open loops, and tags each card
   with provenance.
4. Capsule is rendered as a `[mem:*]` block and pushed via the adapter (hook
   stdout for Claude Code, MCP rider for Cursor/OpenCode, refreshed
   `AGENTS.md` for everyone else).

Nothing leaves your machine. LLM-backed extraction is opt-in via env var; the
default path is fully deterministic and offline.

---

## Troubleshooting

| Symptom                                       | Try                                                    |
| --------------------------------------------- | ------------------------------------------------------ |
| `graphctx doctor` says NOT READY              | `graphctx extract -C .` then re-run doctor             |
| Agent never shows `[mem:*]` block             | `graphctx install <client> -C .` then restart agent    |
| MCP tools list is empty in client             | confirm `graphctx serve --mcp` works in a shell        |
| Hook config got clobbered                     | `graphctx install claude -C .` is idempotent; re-run   |
| Want to wipe state for this repo              | `rm -rf .graphctx`                                     |
| Want to see what the agent will actually see  | `graphctx hook SessionStart -C . < /dev/null`          |

For schema, telemetry, security model, and the offline ablation harness, see
[`docs/SPEC.md`](docs/SPEC.md) and [`docs/PRD.md`](docs/PRD.md).

---

## TL;DR for agents reading this file

```text
1. Run `graphctx init -C .` once per repo.
2. Run `graphctx install auto -C .` once per (repo, client).
3. From now on:
     - Trust [mem:*] blocks in your context.
     - Call MCP `recall` when you need more.
     - Call MCP `remember` when you learn something durable.
     - Call MCP `why` if a fact looks wrong.
4. Never edit .graphctx/ by hand.
```
