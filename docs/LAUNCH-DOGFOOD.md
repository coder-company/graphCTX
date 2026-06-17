# graphCTX Launch Dogfood

Date: 2026-06-17

This is a real-client launch dogfood pass, separate from the deterministic
mission gates. The goal was to check whether graphCTX works in the agent
surfaces users would actually run, especially after memory changes that happen
after static boot grounding is written.

Update: the stale-static-grounding issue found in the first pass is fixed. CLI
and MCP memory writes now refresh the marked graphCTX block in `AGENTS.md`, and
the boot capsule prioritizes recent user/MCP assertions over older extracted
facts. Repeated Cursor/OpenCode floor delivery also replaces the existing
graphCTX block instead of appending duplicates.

## Fixture

- Created throwaway repo at `/tmp/graphctx-dogfood-1781703195/repo` from
  `fixtures/repo-pnpm-web`.
- Ran `graphctx init`, `graphctx install claude`, `graphctx install opencode`,
  and `graphctx install generic`.
- `graphctx doctor` reported `READY` with Claude hooks installed and memory
  populated.
- Seeded one sentinel before install, which was written into `AGENTS.md`.
- Seeded a second sentinel after install:
  `POST_INSTALL_DOGFOOD_SENTINEL_6_GRAPHCTX`.
- Confirmed the second sentinel was absent from `AGENTS.md` and present in
  `graphctx recall "post-install launch dogfood hidden command"`.

## Results

| Client | Command surface | Result |
|---|---|---|
| Claude Code | `pltr -p` | PASS. SessionStart hook emitted the post-install sentinel as `additionalContext`, and Claude answered `POST_INSTALL_DOGFOOD_SENTINEL_6_GRAPHCTX`. Caveat: the artificial `--max-budget-usd 0.10` cap was exceeded after the answer because the invocation created a large prompt cache. |
| Droid | `droid exec` | FAIL unprompted. It answered the older `LAUNCH_DOGFOOD_SENTINEL_6_GRAPHCTX` value from static `AGENTS.md`, not the post-install hidden memory. Explicitly instructing it to run `graphctx recall "post-install launch dogfood hidden command"` passed. |
| OpenCode | `opencode run` | FAIL unprompted. It answered the older static `AGENTS.md` value. Explicit recall passed, and OpenCode used the registered MCP tool (`graphctx_recall`) rather than shelling out, proving the MCP registration works when requested. |
| Codex | `codex exec -p openai-direct` | BLOCKED. The `openai-direct` profile failed with `invalid_refresh_token`; it needs re-auth before it can be used for dogfood. |
| Codex | default `codex exec` | FAIL unprompted. It answered the older static `AGENTS.md` value. Explicitly instructing it to run `graphctx recall "post-install launch dogfood hidden command"` passed via shell command. |
| Claude uninstall | `graphctx uninstall claude` + `graphctx doctor` | Found and fixed a false-positive readiness bug. Uninstall removed hook commands, but doctor previously reported hooks installed because it only checked for `.claude/settings.json`. Doctor now parses settings and requires actual graphCTX hook commands. |

## Post-Fix Results

Fresh fixture: `/tmp/graphctx-dogfood-fix-1781706232/repo`.

After `graphctx init`, adapter installs, and a post-install `graphctx remember`,
the refreshed `AGENTS.md` block listed
`POST_INSTALL_DOGFOOD_SENTINEL_FIX_GRAPHCTX` before the older sentinel. The same
post-install fact was also present in `graphctx recall`.

| Client | Command surface | Post-fix result |
|---|---|---|
| Droid | `droid exec` | PASS unprompted. Returned `POST_INSTALL_DOGFOOD_SENTINEL_FIX_GRAPHCTX`. |
| OpenCode | `opencode run` | PASS unprompted. Returned `POST_INSTALL_DOGFOOD_SENTINEL_FIX_GRAPHCTX`. |
| Codex | default `codex exec` | PASS unprompted. Returned `POST_INSTALL_DOGFOOD_SENTINEL_FIX_GRAPHCTX`. Still logs stale OpenAI auth refresh errors, but the default Palantir-backed run completes. |

## Launch Implications

Claude Code Tier 2 remains the only true proactive push path in this pass:
SessionStart hook context is delivered directly by the client. Droid, OpenCode,
and Codex now recover post-install memory without explicit recall when they
start after the write, because the static boot floor is refreshed.

For Droid, OpenCode, and Codex, static boot grounding previously masked newer
graphCTX facts. The current fix closes that specific class for writes made
before the next client session: `AGENTS.md` now refreshes after CLI/MCP writes,
and recent user/MCP facts sort to the top of the 12-fact boot capsule.

OpenCode's MCP path is usable, but still not proactive in the same sense as
Claude Code hooks. Droid and Codex remain generic/static-floor clients unless
they explicitly call recall or gain native lifecycle hooks.

Before public launch, keep the strongest push-first claim scoped to Claude Code,
and describe Droid/OpenCode/Codex as refreshed static grounding plus recall/MCP
fallback until native lifecycle hooks exist.

## Follow-Up Work

- Fix or re-auth the Codex `openai-direct` profile before including it in a
  release matrix.
- Add a dogfood script that seeds post-install memory and checks each supported
  client for stale static-grounding regressions.
- Keep the uninstall/doctor round trip in the release gate: after uninstall,
  doctor must report `claude hooks: not installed` even if `.claude/settings.json`
  still exists.
- Add first-class native lifecycle support where possible for Droid, OpenCode,
  and Codex instead of relying on static boot grounding plus recall.
- Improve OpenCode/Codex/Droid instructions so "hidden/current graphCTX memory"
  routes to live recall by default.
- Keep Claude Code budget/cost behavior in the release checklist when running
  hook-enabled print-mode tests.
