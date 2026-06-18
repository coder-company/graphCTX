# graphCTX — Live Demo (≈3 minutes, offline)

> M0 proves the thesis (push beats pull); M1–M4 build it out (memory core,
> relevance gate, branch-truth + conflict resolution, multi-client + MCP). Each
> milestone has a live gate — see §4c–§4f. The M0 headline below is still the
> fastest way to *see* the difference.


> **The one question M0 answers:** does *pushed* memory beat *pulled* memory when
> a coding agent drifts under compaction?
>
> **Yes** — and the headline proof is live: the *same* Claude Code agent, asked
> the *same* question, says **"I don't know"** without graphCTX and answers
> **correctly** with it. The only difference is a lifecycle-hook *push*.

---

## 0. One-time setup (~30s, offline)

```bash
npm install          # builds better-sqlite3 (no network calls at runtime)
npm run build        # tsc → dist/   (optional: you can run from source via tsx)

# put `graphctx` on PATH for the hook handler the agent invokes:
npm link             # exposes `graphctx` → dist/cli.js
# ...or a dev shim:
printf '#!/usr/bin/env bash\nexec npx tsx %s/src/cli.ts "$@"\n' "$PWD" > ~/.local/bin/graphctx && chmod +x ~/.local/bin/graphctx
```

---

## 1. The headline: live negative-control (the part you should watch)

One command scaffolds everything — a scratch repo, a deploy command stored
**only in graphCTX memory** (it appears in *no repo file*), hooks wired up, and
`AGENTS.md` removed so the **push hook is the only channel** that can supply it:

```bash
npm run demo            # → /tmp/graphctx-demo  (prints a copy-paste script)
```

Now run the *same* agent, *same* prompt, twice:

```bash
ASK='What is the exact deploy command for this project? Output it verbatim on one line. If you do not know, say you do not know. Do not read files or run tools.'

# WITHOUT graphCTX (negative control)
cp -r /tmp/graphctx-demo /tmp/graphctx-demo-bare
rm -rf /tmp/graphctx-demo-bare/.graphctx /tmp/graphctx-demo-bare/.claude
( cd /tmp/graphctx-demo-bare && echo "$ASK" | claude -p --permission-mode bypassPermissions )

# WITH graphCTX (push via SessionStart hook)
( cd /tmp/graphctx-demo && echo "$ASK" | claude -p --permission-mode bypassPermissions )
```

**Observed, live:**

| | Agent answer |
|---|---|
| **WITHOUT graphCTX** | *"I don't know. ... I have no prior knowledge of this project's deploy command."* |
| **WITH graphCTX** | `./scripts/ship.sh --canary --wait`  *(agent notes: "comes from session memory")* |

Same agent. Same repo. Same prompt. The deploy command exists in **no file** —
the agent could only have learned it from the graphCTX hook push. **That is push
beating pull, live.**

---

## 2. The backup: automated A/B/C eval + integrity controls

```bash
npm run eval -- --arms A,B,C,N,S      # or: graphctx eval run --arms A,B,C,N,S
```

Each `fixtures/repo-*` is copied to a temp dir; the **real** deterministic
extractors run, the **real** PostCompact capsule is built by the planner, then:

- **A — no memory:** retains nothing → wrong every time.
- **B — pull-only:** *may* call `recall`, but only when the model remembers to
  (model-controlled compliance — the thesis' core weakness).
- **C — push:** graphCTX pushes the capsule at `PostCompact`, guaranteed.
- **N — negative-control:** a fact present in *no repo file*; push must deliver it.
- **S — stale-fact:** a fact whose target path no longer exists; graphCTX must
  *suppress* it (proves I4 verification, not blind recall).

Observed result:

```
Arm                     Solve rate    Correct cmds  Repeated-fail Tokens
------------------------------------------------------------------------
A · no memory           0% (0/14)     0             11            0
B · pull-only (recall)  21% (3/14)    2             9             0
C · push (graphCTX)     93% (13/14)   10            1             724

Integrity controls (guard against a tautological eval):
  N · negative-control   5/5 repos → PASS   (push delivers an unfindable fact)
  S · stale-fact         5/5 repos → PASS   (graphCTX suppresses an invalid fact)

M0 GATE — does C (push) beat B (pull)?
  post-compaction solve rate:  C 93% vs B 21%   → PASS
  repeated failed commands:    C 1 vs B 9       → PASS
  VERDICT: ✅ PUSH BEATS PULL — M0 thesis validated.
```

> **How to read it:** the A/B/C gap shows push reliably *delivers* what pull
> leaves to chance. **N is the honest headline** — push supplies a fact the agent
> provably cannot read from files. **S** shows graphCTX does not blindly recall.

---

## 3. It never breaks the agent, and it's fast

```bash
npm test                 # includes 12 resilience tests + a latency guard
npm run bench            # hook hot-path latency
```

- **Resilience (I9):** with a corrupt DB, invalid/schema-bad config, or missing
  git, the hook exits `0` and emits **nothing** — a broken graphCTX degrades to
  *no memory*, never a *broken agent*.
- **Latency (SPEC §24):** retrieval + render **p95 15.78ms** in the latest
  local bench run (budget < 150ms).

---

## 4. Inspect the machinery

```bash
# the exact capsule the SessionStart / PostCompact hook emits (Tier-2 push)
echo '{"session_id":"s","cwd":"/tmp/graphctx-demo"}' | graphctx hook PostCompact -C /tmp/graphctx-demo

graphctx extract -C /tmp/graphctx-demo     # durable facts the extractors found
graphctx recall "run the tests" -C /tmp/graphctx-demo   # pull fallback (NOT the primary channel)
graphctx doctor -C /tmp/graphctx-demo      # health verdict
```

A capsule (note `[mem:<id>]` provenance on every card — I7):

```
## Restored memory after compaction (graphCTX)

**Repo constraints:**
- Run tests with: npm run test. Verified @ 77c507d. [mem:Z9AZX43T]
- This repo uses pnpm (not other package managers). [mem:DCBJ5ZXY]
- Do not edit src/generated/api-types.ts — it is generated. [mem:F9A9VWBJ]
- Indentation: space (size 2) (enforced by .editorconfig). [mem:904CQF3F]

**Applicable procedure:**
- repo deploy command: ./scripts/ship.sh --canary --wait [mem:X05Z6R45]
```

---

## 4b. Open loops survive compaction (M1)

An *open loop* is unfinished work. graphCTX re-hands it at every PostCompact /
SessionStart until it is resolved — so "what was I doing?" is never lost to a
context window flush.

```bash
# mid-task, record the thread you're on
graphctx loop "finish wiring retry backoff in api.ts, then add the test" -C /tmp/graphctx-demo

# ...context gets compacted... the next capsule leads with it:
echo '{"session_id":"s","cwd":"/tmp/graphctx-demo"}' | graphctx hook PostCompact -C /tmp/graphctx-demo
```

```
## Restored memory after compaction (graphCTX)

**Open loops / unfinished work:**
- Unfinished: finish wiring retry backoff in api.ts, then add the test [mem:7K2QF8AB]

**Repo constraints:**
- ...
```

It keeps resurfacing across repeated compactions (exempt from anti-repetition).
Close it when done and it stops appearing:

```bash
graphctx resolve 7K2QF8AB -C /tmp/graphctx-demo   # accepts the [mem:<id>] suffix
```

Trace any card's full evidence chain (events, asserter, git anchor, promotion
gate, supersession edges):

```bash
graphctx why 7K2QF8AB -C /tmp/graphctx-demo
```

---

## 4c. Selective mid-session push (M2 — the relevance gate)

Push is only valuable if it fires at the *right* moment. The relevance gate
fires on SessionStart/PostCompact (always), on topic drift / new entities at
`UserPromptSubmit`, and **selectively** at `PreToolUse` — only when memory
plausibly applies (a concrete `Bash` command, an `Edit`/`Write` on a real path),
not on every tool call.

```bash
graphctx eval drift -C /tmp/graphctx-demo
```

```
  PreToolUse fired on 11/35 calls (rate 31%) — selective
  harmful injections: 0/35 cards (rate 0%)
  cross-channel duplicate cards: 0
  VERDICT: ✅ M2 GATE PASS — selective gate, zero harmful injections, no cross-channel dupes.
```

The DB-backed ledger guarantees a fact pushed by a short-lived hook is **not**
re-pushed by the long-lived MCP rider in the same session (cross-channel
idempotency). Open loops are exempt by design.

---

## 4d. Truth across branches + conflict resolution (M3)

```bash
graphctx eval branch       # facts don't leak across branches; revert restores truth
graphctx eval conflict     # parallel writes never silent-LWW (partition/dispute/surface)
graphctx eval procedure    # LLM extraction safe: secrets dropped, trust capped, evidence verified
```

LLM extraction (optional, async, off the hot path) runs **only when a key is
configured** — with no key graphCTX runs in deterministic-only mode and never
blocks the agent. Extracted facts are capped to low trust (I2), secret-scrubbed
(I3), and their cited evidence is verified against real episodes.

---

## 4e. Any client + the MCP surface (M4)

graphCTX is not Claude-only, but the channels are not equivalent. Claude Code is
the true lifecycle-push path today; hookless clients get the Tier-0 `AGENTS.md`
floor plus Tier-1 MCP recall/riders.

```bash
graphctx install cursor      # writes .cursor/rules + registers MCP recall
graphctx install opencode    # registers MCP recall in opencode.json
graphctx install auto        # auto-detect the client in this workspace

# the long-lived MCP server (stdio JSON-RPC) exposes EXACTLY 8 tools (I8):
graphctx serve --mcp
#   remember · recall · inject_context · checkpoint_session
#   promote · forget · why · resolve_conflict
```

```bash
graphctx eval mcp            # install per client + MCP 8-tool smoke + secure proxy
```

```
  ✓ MCP exposes EXACTLY 8 tools (I8) — got 8
  ✓ MCP remember refuses secret-bearing memory without echoing the secret
  ✓ proxy (enabled) refuses a capsule that trips the secret scanner (I3)
  checks: 84/84   MCP tools: 8 (must be 8)   proxy leaks: 0 (must be 0)
  VERDICT: ✅ M4 GATE PASS — multi-client install, MCP 8-tool surface, secure proxy, telemetry classifies.
```

The Tier-4 proxy (rewrite outgoing context for hookless clients) is **opt-in
only** and refuses to inject any capsule that trips the secret scanner.

---

## 4f. Run every gate at once

```bash
graphctx eval all     # 19 suites: A/B/C/N/S, memory, promote, drift, retrieval, gate, security, branch, temporal, conflict, procedure, mcp, storage, telemetry, provenance, resilience, benchmarks, cli-docs-demo, quality
```

---

## 5. What this demonstrates (mapped to the thesis)

- **Push is deterministic; pull is a compliance lottery.** Arm C fires every time;
  arm B only when the model remembers to ask — which it does not, post-compaction.
- **Commit-valid grounding.** Facts carry git anchors (`valid_from_commit`) and are
  filtered to HEAD by ancestry before injection.
- **No poisoning.** Repo prose is low-trust and framed as a claim (I2); secrets are
  scrubbed (I3); perishable facts are verified to still exist before injection (I4);
  every card is budget-bounded (I6) and provenance-tagged (I7).
- **Never a broken agent (I9).** Every hook path is wrapped; any failure emits an
  empty capsule rather than crashing the session.

> **Bottom line: push beats pull under compaction. M0 gate passed — earn the rest.**
