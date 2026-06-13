# graphCTX M0 — Live Demo

> **The one question M0 answers: does *pushed* memory beat *pulled* memory when a
> coding agent drifts under compaction?**
>
> M0 says **yes** — proven two ways: (1) an automated A/B/C eval across 5 sample
> repos, and (2) a live Claude Code agent that recalls a memory-only fact *only*
> when graphCTX pushes it via a lifecycle hook.

---

## 0. Setup (one time)

```bash
npm install          # builds better-sqlite3, biome, esbuild
npm run build        # tsc → dist/  (or use `npx tsx src/cli.ts` directly)
```

Put `graphctx` on your PATH (for the hook handler the client invokes):

```bash
# option A: link the built binary
npm link             # exposes `graphctx` → dist/cli.js
# option B: dev shim
printf '#!/usr/bin/env bash\nexec npx tsx %s/src/cli.ts "$@"\n' "$PWD" > ~/.local/bin/graphctx
chmod +x ~/.local/bin/graphctx
```

---

## 1. The automated proof — A/B/C eval (the M0 gate)

```bash
graphctx eval run --suite compaction-recovery --arms A,B,C
```

This copies each `fixtures/repo-*` to a temp dir, runs the **real** deterministic
extractors, builds the **real** PostCompact capsule via the planner, then scores
three arms on each repo's post-compaction needs:

- **A — no memory:** agent retains nothing → guesses wrong every time.
- **B — pull-only:** agent *may* call `recall`, but only when it remembers to
  (model-controlled compliance) — the thesis' core weakness.
- **C — push:** graphCTX pushes the capsule at `PostCompact`, guaranteed.

Observed result:

```
Arm                     Solve rate    Correct cmds  Repeated-fail Tokens
------------------------------------------------------------------------
A · no memory           0% (0/14)     0             11            0
B · pull-only (recall)  21% (3/14)    2             9             0
C · push (graphCTX)     100% (14/14)  11            0             711

M0 GATE — does C (push) beat B (pull)?
  post-compaction solve rate:  C 100% vs B 21%  → PASS
  repeated failed commands:    C 0 vs B 9       → PASS
  VERDICT: ✅ PUSH BEATS PULL — M0 thesis validated.
```

---

## 2. The live proof — a real agent forgets, then graphCTX pushes it back

This isolates the **push channel** by storing a fact that exists in *no repo
file* — only in graphCTX memory — so the agent's only path to it is the hook.

### 2a. Prepare a demo repo

```bash
cp -r fixtures/repo-pnpm-web /tmp/demo && cd /tmp/demo
git init -q && git add -A && git commit -qm init
```

### 2b. Seed a memory-only fact (simulates a promoted user decision)

```bash
graphctx remember "./scripts/ship.sh --canary --wait" \
  --predicate deploy_command --kind procedural -C /tmp/demo
```

The key point: **`ship.sh` appears in no file in the repo** — it lives only in
graphCTX's store, so the agent's only path to it is the hook push.

### 2c. Install the push hooks and remove the static AGENTS.md grounding

```bash
graphctx install claude -C /tmp/demo
rm -f /tmp/demo/AGENTS.md     # force the ONLY channel to be the SessionStart hook
```

### 2d. Ask a real Claude Code agent — WITH graphCTX

```bash
cd /tmp/demo
echo "What is the exact deploy command for this project? Output it verbatim. Do not read files." \
  | claude -p --permission-mode bypassPermissions
```

> **Agent output:**
> ```
> Based on memory (unverified, since you asked me not to read files):
> ./scripts/ship.sh --canary --wait
> ```

The SessionStart hook pushed graphCTX's capsule into the agent's context — and it
recalled a command that lives nowhere in the repo.

### 2e. Negative control — WITHOUT graphCTX

```bash
cp -r fixtures/repo-pnpm-web /tmp/demo-bare && cd /tmp/demo-bare
rm -rf .graphctx .claude AGENTS.md
echo "What is the exact deploy command for this project? Output it verbatim. Do not read files." \
  | claude -p --permission-mode bypassPermissions
```

> **Agent output:**
> ```
> I don't know it. ... the working directory is fresh to me ... nothing in memory
> covers it ... I won't guess at a deploy command.
> ```

**Same agent, same repo, same prompt. The only difference is whether graphCTX
pushed the memory.** That is push beating pull, live.

---

## 3. Inspect the machinery

```bash
# what the SessionStart / PostCompact hook actually emits (Tier-2 push)
echo '{"session_id":"s1","cwd":"/tmp/demo"}' | graphctx hook PostCompact -C /tmp/demo

# the durable facts the deterministic extractors found
graphctx extract -C /tmp/demo

# pull-style query (the fallback path; NOT the primary channel)
graphctx recall "how do I run the tests" -C /tmp/demo

# health check
graphctx doctor -C /tmp/demo
```

A capsule looks like this (note `[mem:<id>]` provenance on every card — I7):

```
## Restored memory after compaction (graphCTX)

**Repo constraints:**
- Run tests with: npm run test. Verified @ 44bdb79. [mem:K0P3NRZ8]
- This repo uses pnpm (not other package managers). [mem:3F69WABH]
- Do not edit src/generated/api-types.ts — it is generated. [mem:TZNP8JH9]
- Indentation: space (size 2) (enforced by .editorconfig). [mem:QWCKT48X]
```

---

## 4. What this demonstrates (mapped to the thesis)

- **Push is deterministic; pull is a compliance lottery.** Arm C fires every time;
  arm B only when the model remembers to ask — which it does not, post-compaction.
- **Commit-valid grounding.** Facts carry git anchors (`valid_from_commit`) and are
  filtered to HEAD by ancestry before injection.
- **No poisoning.** Repo prose is low-trust and framed as a claim (I2); secrets are
  scrubbed (I3); perishable facts are verified to still exist before injection (I4);
  every card is budget-bounded (I6) and provenance-tagged (I7).
- **Never a broken agent.** Every hook path is wrapped; any failure emits an empty
  capsule (I9) rather than crashing the session.

> **Bottom line: push beats pull under compaction. M0 gate passed — earn the rest.**
