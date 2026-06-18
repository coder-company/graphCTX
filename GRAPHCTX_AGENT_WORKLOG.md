# graphCTX Agent Worklog

This log tracks accepted foreground improvement iterations. The machine-readable
autoresearch audit remains in `autoresearch-results/results.tsv`.

## 2026-06-17

### Iteration 36 - deterministic tsconfig extraction

- Added high-trust deterministic extraction for root `tsconfig.json` compiler
  options, include/exclude globs, and extends metadata.
- Wired the extractor into the deterministic pipeline so normal no-LLM
  extraction records TypeScript project evidence with git anchors.
- Added JSONC parsing support for comments and trailing commas, matching normal
  tsconfig syntax.
- Added a regression test for high-trust TypeScript compiler constraints.
- Updated README, STATUS, and SPEC counters from 6 to 7 deterministic
  extractors and from 194 to 195 Vitest tests.
- Verification:
  - `npx biome check src/extract/pipeline.ts src/extract/deterministic/tsconfig.ts test/extract/extractors.test.ts README.md docs/STATUS.md docs/SPEC.md`
  - `npx vitest run test/extract/extractors.test.ts`
  - `npx tsc --noEmit`
  - `npx tsx src/cli.ts eval quality`
  - `npx tsx src/cli.ts eval cli-docs-demo`

### Iteration 37 - deterministic tooling config extraction

- Added high-trust deterministic extraction for lint/format config files:
  Biome, ESLint, and Prettier.
- Extracted Biome format, import organization, and linter rule constraints from
  structured JSONC config while keeping arbitrary JS/YAML configs to existence
  facts only.
- Moved JSONC parsing into a shared internal deterministic extractor helper.
- Added a regression test for Biome lint/format/rule facts.
- Updated README, STATUS, and SPEC counters from 7 to 8 deterministic
  extractors and from 195 to 196 Vitest tests.
- Verification:
  - `npx biome check src/extract/pipeline.ts src/extract/deterministic/jsonc.ts src/extract/deterministic/tooling-config.ts src/extract/deterministic/tsconfig.ts test/extract/extractors.test.ts README.md docs/STATUS.md docs/SPEC.md GRAPHCTX_AGENT_WORKLOG.md`
  - `npx vitest run test/extract/extractors.test.ts`
  - `npx tsc --noEmit`
  - `npx tsx src/cli.ts eval quality`
  - `npx tsx src/cli.ts eval cli-docs-demo`

### Iteration 38 - deterministic Docker and Compose extraction

- Added high-trust deterministic extraction for Dockerfile and Docker Compose
  configuration.
- Extracted base images, build stages, workdir, exposed ports, container users,
  compose services, images, build contexts, and ports with git path anchors.
- Added a regression test for Dockerfile and Compose facts.
- Updated README, STATUS, and SPEC counters from 8 to 9 deterministic
  extractors and from 196 to 197 Vitest tests.
- Verification:
  - `npx biome check src/extract/pipeline.ts src/extract/deterministic/docker.ts test/extract/extractors.test.ts README.md docs/STATUS.md docs/SPEC.md GRAPHCTX_AGENT_WORKLOG.md`
  - `npx vitest run test/extract/extractors.test.ts`
  - `npx tsc --noEmit`
  - `npx tsx src/cli.ts eval quality`
  - `npx tsx src/cli.ts eval cli-docs-demo`

### Iteration 39 - deterministic test config extraction

- Added high-trust deterministic extraction for test runner config files:
  Vitest, Jest, Playwright, and Cypress.
- Extracted Vitest runner, environment, timeout, include/exclude globs, and
  coverage provider/globs from config text without executing config code.
- Added a regression test for Vitest runner and coverage facts.
- Updated README, STATUS, and SPEC counters from 9 to 10 deterministic
  extractors and from 197 to 198 Vitest tests.
- Verification:
  - `npx biome check src/extract/pipeline.ts src/extract/deterministic/test-config.ts test/extract/extractors.test.ts README.md docs/STATUS.md docs/SPEC.md GRAPHCTX_AGENT_WORKLOG.md`
  - `npx vitest run test/extract/extractors.test.ts`
  - `npx tsc --noEmit`
  - `npx tsx src/cli.ts eval quality`
  - `npx tsx src/cli.ts eval cli-docs-demo`

### Iteration 40 - deterministic package metadata extraction

- Expanded the existing package.json deterministic extractor beyond scripts.
- Added high-trust facts for package name, Node module type, Node engine
  constraint, declared package manager, CLI bin mappings, and workspace globs.
- Extended the package extraction regression test to cover Node engine and CLI
  bin metadata.
- Verification:
  - `npx biome check src/extract/deterministic/package-scripts.ts test/extract/extractors.test.ts docs/STATUS.md GRAPHCTX_AGENT_WORKLOG.md`
  - `npx vitest run test/extract/extractors.test.ts`
  - `npx tsc --noEmit`
  - `npx tsx src/cli.ts eval quality`
  - `npx tsx src/cli.ts eval cli-docs-demo`

### Iteration 41 - workspace-confined staleness paths

- Hardened injection staleness verification so concrete fact path anchors must
  resolve inside the workspace before they can prove a fact is still valid.
- Added a regression test with a real parent-directory file proving
  `../outside.txt` anchors are not injected even when the outside file exists.
- Updated README and STATUS counters from 198 to 199 Vitest tests.
- Verification:
  - `npx biome check src/inject/staleness.ts test/inject/planner.test.ts README.md docs/STATUS.md GRAPHCTX_AGENT_WORKLOG.md`
  - `npx vitest run test/inject/planner.test.ts`
  - `npx tsc --noEmit`
  - `npx tsx src/cli.ts eval cli-docs-demo`
  - `npx tsx src/cli.ts eval quality`

### Iteration 42 - scoped semantic retrieval expansion

- Extended bounded semantic expansion to scan current session and user-scoped
  active facts before workspace facts, capped at the existing semantic scan cap.
- Added a regression test proving a user-scoped secret-handling preference with
  no BM25 keyword overlap is still retrieved semantically.
- Updated README and STATUS counters from 199 to 200 Vitest tests.
- Verification:
  - `npx biome check src/retrieve/retriever.ts test/retrieve/retriever.test.ts README.md docs/STATUS.md GRAPHCTX_AGENT_WORKLOG.md`
  - `npx vitest run test/retrieve/retriever.test.ts test/retrieve/vectors.test.ts test/eval/retrieval-quality.test.ts`
  - `npx tsc --noEmit`
  - `npx tsx src/cli.ts eval retrieval`
  - `npx tsx src/cli.ts eval cli-docs-demo`
  - `npx tsx src/cli.ts eval quality`

### Iteration 43 - auth and cookie header secret scanning

- Added explicit secret patterns for Authorization headers and cookie/session
  headers so low-entropy bearer/session material is blocked and redacted without
  relying on entropy heuristics.
- Extended secret scanner tests for detection and redaction of auth and cookie
  headers.
- Verification:
  - `npx biome check src/security/secrets.ts test/security/secrets.test.ts docs/STATUS.md GRAPHCTX_AGENT_WORKLOG.md`
  - `npx vitest run test/security/secrets.test.ts test/security/promotion-injection.test.ts test/eval/security-adversarial.test.ts`
  - `npx tsc --noEmit`
  - `npx tsx src/cli.ts eval security`
  - `npx tsx src/cli.ts eval quality`

### Iteration 44 - semantic CLI recall

- Wired `graphctx recall` through the runtime's local vector index so pull
  fallback ranking matches MCP/injection retrieval instead of BM25-only ranking.
- Added a core-memory CLI eval check proving semantic recall ranks a
  secret-handling preference ahead of an earlier broad-pass distractor.
- Verification:
  - `npx biome check src/cli.ts src/eval/suites/core-memory-lifecycle.ts docs/STATUS.md GRAPHCTX_AGENT_WORKLOG.md`
  - `npx vitest run test/eval/core-memory-lifecycle.test.ts`
  - `npx tsc --noEmit`
  - `npx tsx src/cli.ts eval memory`
  - `npx tsx src/cli.ts eval quality`

### Iteration 45 - fail-closed commit-scoped retrieval

- Made retrieval suppress commit/repo/branch-scoped facts when no Git adapter is
  available or Git validity checks throw, while still allowing unanchored memory.
- Added retriever regressions for no-Git and broken-Git stale-memory suppression.
- Verification:
  - `npx biome check src/retrieve/retriever.ts test/retrieve/retriever.test.ts README.md docs/STATUS.md GRAPHCTX_AGENT_WORKLOG.md`
  - `npx vitest run test/retrieve/retriever.test.ts`
  - `npx tsc --noEmit`
  - `npx tsx src/cli.ts eval retrieval`
  - `npx tsx src/cli.ts eval temporal`
  - `npx tsx src/cli.ts eval quality`

### Iteration 46 - MCP error redaction

- Redacted MCP JSON-RPC error messages and tool error text through the existing
  secret scanner before any server response reaches stdout.
- Added adapter/MCP gate checks for secret-shaped validation arguments and
  unknown tool names, raising the MCP gate to 74/74 checks.
- Verification:
  - `npx biome check src/mcp/server.ts src/eval/suites/adapters-mcp.ts docs/STATUS.md GRAPHCTX_AGENT_WORKLOG.md`
  - `npx vitest run test/eval/adapters-mcp.test.ts`
  - `npx tsc --noEmit`
  - `npx tsx src/cli.ts eval mcp`
  - `npx tsx src/cli.ts eval security`
  - `npx tsx src/cli.ts eval quality`

### Iteration 47 - multi-cookie session redaction

- Fixed cookie/session secret scanning so a sensitive cookie is detected even
  when it appears after benign cookies in a `Cookie:` header.
- Added unit and adversarial security coverage for delayed session cookies.
- Verification:
  - `npx biome check src/security/secrets.ts test/security/secrets.test.ts src/eval/suites/security-adversarial.ts docs/STATUS.md GRAPHCTX_AGENT_WORKLOG.md`
  - `npx vitest run test/security/secrets.test.ts test/security/promotion-injection.test.ts test/eval/security-adversarial.test.ts`
  - `npx tsc --noEmit`
  - `npx tsx src/cli.ts eval security`
  - `npx tsx src/cli.ts eval quality`

### Iteration 48 - deterministic runtime version extraction

- Added a high-trust deterministic extractor for `.nvmrc`, `.node-version`, and
  `.tool-versions` runtime version pins.
- Wired the extractor into the no-LLM pipeline and added regression coverage for
  Node and pnpm runtime pins with git path anchors.
- Verification:
  - `npx biome check src/extract/pipeline.ts src/extract/deterministic/runtime-version.ts test/extract/extractors.test.ts README.md docs/STATUS.md docs/SPEC.md GRAPHCTX_AGENT_WORKLOG.md`
  - `npx vitest run test/extract/extractors.test.ts`
  - `npx tsc --noEmit`
  - `npx tsx src/cli.ts eval memory`
  - `npx tsx src/cli.ts eval quality`
  - `npx tsx src/cli.ts eval cli-docs-demo`

### Iteration 49 - package-manager-aware script extraction

- Made package script command facts use the declared `packageManager` or lockfile
  runner instead of always emitting `npm run <script>`.
- Updated pnpm, yarn, and bun fixture expectations so eval truth matches the
  actual package manager for each repo.
- Verification:
  - `npx biome check src/extract/deterministic/package-scripts.ts test/extract/extractors.test.ts fixtures/repo-pnpm-web/scenario.json fixtures/repo-pnpm-mono/scenario.json fixtures/repo-yarn-api/scenario.json fixtures/repo-bun-lib/scenario.json fixtures/README.md README.md docs/STATUS.md GRAPHCTX_AGENT_WORKLOG.md`
  - `npx vitest run test/extract/extractors.test.ts test/eval/harness.test.ts`
  - `npx tsc --noEmit`
  - `npx tsx src/cli.ts eval run --arms A,B,C,N,S`
  - `npx tsx src/cli.ts eval cli-docs-demo`
  - `npx tsx src/cli.ts eval quality`

### Iteration 50 - packageManager canonical package facts

- Emitted canonical `package_manager` facts from `package.json packageManager`
  declarations so repos without lockfiles still get package-manager memory.
- Extended the package-script extractor regression to cover that canonical fact.
- Verification:
  - `npx biome check src/extract/deterministic/package-scripts.ts test/extract/extractors.test.ts docs/STATUS.md GRAPHCTX_AGENT_WORKLOG.md`
  - `npx vitest run test/extract/extractors.test.ts test/eval/harness.test.ts`
  - `npx tsc --noEmit`
  - `npx tsx src/cli.ts eval run --arms A,B,C,N,S`
  - `npx tsx src/cli.ts eval quality`
  - `npx tsx src/cli.ts eval cli-docs-demo`

### Iteration 51 - explicit memory metadata secret refusal

- Centralized explicit memory intake checks across text and metadata fields so
  CLI/MCP `remember` refuses secret-shaped `subject`, `predicate`, `kind`, and
  MCP `session_id` values before Runtime or DB writes.
- Added unit, CLI lifecycle, and MCP regressions proving metadata-carried
  credentials are refused and not echoed.
- Updated README/STATUS/DEMO counters to 205 Vitest tests and 75/75 MCP checks.
- Verification:
  - `npx vitest run test/security/secrets.test.ts`
  - `npx tsx src/cli.ts eval memory`
  - `npx tsx src/cli.ts eval mcp`
  - `npx biome check src/security/intake.ts src/cli.ts src/mcp/tools.ts src/eval/suites/core-memory-lifecycle.ts src/eval/suites/adapters-mcp.ts test/security/secrets.test.ts`
- Recoverable failures:
  - Initial file-shaped eval commands `npx tsx src/cli.ts eval core-memory-lifecycle`
    and `npx tsx src/cli.ts eval adapters-mcp` failed because the CLI exposes
    grouped gate names; reran the correct `memory` and `mcp` gates successfully.

### Iteration 52 - open-loop session metadata secret refusal

- Moved open-loop secret intake protection into `Runtime.noteOpenLoop`, covering
  CLI, TUI, tests, and any direct Runtime caller before the open-loop fact is
  assembled.
- Added CLI preflight validation for `loop --session` so secret-shaped session
  ids are refused before opening the workspace Runtime.
- Added Runtime and CLI lifecycle regressions proving unsafe session metadata is
  refused and no open-loop row resurfaces.
- Updated README/STATUS counters to 206 Vitest tests.
- Verification:
  - `npx biome check --write src/runtime.ts src/cli.ts src/eval/suites/core-memory-lifecycle.ts test/inject/open-loops.test.ts`
  - `npx vitest run test/inject/open-loops.test.ts`
  - `npx tsx src/cli.ts eval memory`

### Iteration 53 - MCP session-reference secret refusal

- Added MCP session-reference intake validation for `recall`, `inject_context`,
  `checkpoint_session`, `promote`, and `resolve_conflict` so secret-shaped
  session ids are refused before retrieval, planning, promotion, conflict
  resolution, injection logging, or ledger writes.
- Added an MCP recall regression proving secret-bearing session metadata is
  rejected and not echoed.
- Updated STATUS/DEMO MCP gate counters to 76/76 checks.
- Verification:
  - `npx biome check --write src/mcp/tools.ts src/eval/suites/adapters-mcp.ts`
  - `npx tsx src/cli.ts eval mcp`
  - `npx tsc --noEmit`
  - `npx tsx src/cli.ts eval cli-docs-demo`
  - `npx tsx src/cli.ts eval quality`
  - `npx biome check src test`

### Iteration 54 - hook session-id redaction

- Normalized secret-shaped Claude hook `session_id` values to
  `redacted-session` before episode capture, promotion sweep, injection
  planning, injection logging, or ledger writes.
- Strengthened hook resilience tests and eval coverage so payload secrets and
  session-id secrets are both absent from persisted episode data.
- Updated README/STATUS counters to 207 Vitest tests.
- Verification:
  - `npx biome check --write src/adapters/claude-code/hooks.ts test/resilience/hook-degrades.test.ts src/eval/suites/resilience-failsoft.ts`
  - `npx vitest run test/resilience/hook-degrades.test.ts`
  - `npx tsx src/cli.ts eval resilience`

### Iteration 55 - CLI unknown-id secret redaction

- Redacted user-supplied unknown fact ids in CLI `resolve` and `why` output so
  secret-shaped arguments are not echoed back to stdout.
- Added a core memory lifecycle regression for secret-shaped unknown ids across
  both commands, raising the memory gate to 14/14 checks.
- Verification:
  - `npx biome check --write src/cli.ts src/eval/suites/core-memory-lifecycle.ts`
  - `npx tsx src/cli.ts eval memory`
  - `npx tsc --noEmit`

### Iteration 56 - extraction subject secret scanning

- Extended deterministic and LLM extraction secret checks to include fact
  subjects, preventing secret-shaped paths or model-proposed subjects from
  becoming stored facts.
- Added deterministic generated-file subject coverage and a focused LLM
  extractor regression with a fake provider.
- Updated README/STATUS counters to 209 Vitest tests.
- Verification:
  - `npx biome check --write src/extract/pipeline.ts src/extract/llm/fact-extractor.ts test/extract/extractors.test.ts test/extract/llm-fact-extractor.test.ts`
  - `npx vitest run test/extract/extractors.test.ts test/extract/llm-fact-extractor.test.ts`
  - `npx tsc --noEmit`
  - `npx biome check src test`
  - `npx tsx src/cli.ts eval procedure`
  - `npx tsx src/cli.ts eval security`
  - `npx tsx src/cli.ts eval cli-docs-demo`
  - `npx tsx src/cli.ts eval quality`
- Recoverable failures:
  - Initial `npx tsx src/cli.ts eval cli-docs-demo` caught stale docs counters
    at 208/209 tests; updated README/STATUS to the live 209 count.

### Iteration 57 - procedure verifier secret scanning

- Included procedure verifier commands in LLM procedure-mining secret scans so a
  model cannot return a safe-looking procedure with a credential-bearing
  verifier command for persistence.
- Extended the procedure-memory eval with a secret verifier procedure that must
  be dropped, raising the gate to 7/7 checks.
- Verification:
  - `npx biome check --write src/extract/llm/procedure-miner.ts src/eval/suites/procedure-memory.ts`
  - `npx tsx src/cli.ts eval procedure`
  - `npx tsc --noEmit`

### Iteration 58 - generated-marker symlink skip

- Switched generated-marker extraction from `statSync` to `lstatSync` and skip
  symlinks, preventing deterministic extraction from walking outside the
  workspace through symlinked directories.
- Added a regression with a symlinked external generated file and updated
  README/STATUS counters to 210 Vitest tests.
- Verification:
  - `npx biome check --write src/extract/deterministic/generated-markers.ts test/extract/extractors.test.ts`
  - `npx vitest run test/extract/extractors.test.ts`
  - `npx tsc --noEmit`
  - `npx biome check src test`
  - `npx tsx src/cli.ts eval cli-docs-demo`
  - `npx tsx src/cli.ts eval quality`

### Iteration 59 - symlink-aware injection staleness

- Changed pre-injection staleness verification to compare canonical real paths,
  preventing path-anchored facts from being injected when their evidence exists
  only through a symlink that resolves outside the workspace.
- Added a planner regression for `do_not_edit` memory anchored through an
  external symlink and updated README/STATUS counters to 211 Vitest tests.
- Verification:
  - `npx vitest run test/inject/planner.test.ts`
  - `npx tsc --noEmit`
  - `npx biome check src test`

### Iteration 60 - shared workspace evidence realpath checks

- Added a shared workspace path evidence helper that requires both lexical
  containment and canonical real-path containment.
- Reused the helper in injection staleness and invalidation relation checks so
  stale-fact suppression and evidence disappearance use the same semantics.
- Added an invalidation regression where a path anchor exists only through a
  symlink resolving outside the workspace and updated README/STATUS counters to
  212 Vitest tests.
- Verification:
  - `npx vitest run test/invalidate/invalidator.test.ts test/inject/planner.test.ts`
  - `npx tsc --noEmit`
  - `npx biome check src test`

### Iteration 61 - workspace-confined package script evidence

- Hardened package script extraction so `package.json` and lockfile runner
  evidence must resolve inside the workspace before becoming structured memory.
- Added a regression covering an external symlinked `package.json` and an
  external symlinked `pnpm-lock.yaml`; the latter no longer changes the runner
  from npm to pnpm.
- Updated README/STATUS counters to 213 Vitest tests.
- Verification:
  - `npx vitest run test/extract/extractors.test.ts`
  - `npx tsc --noEmit`
  - `npx biome check --write test/extract/extractors.test.ts`
  - `npx biome check src test`

### Iteration 62 - workspace-confined lockfile extraction

- Hardened standalone lockfile extraction so package-manager facts require
  lockfile evidence that resolves inside the workspace.
- Added a regression for an external symlinked `pnpm-lock.yaml` that must not
  create a `package_manager` fact.
- Updated README/STATUS counters to 214 Vitest tests.
- Verification:
  - `npx vitest run test/extract/extractors.test.ts`
  - `npx tsc --noEmit`
  - `npx biome check src test`

### Iteration 63 - workspace-confined runtime version extraction

- Hardened runtime version extraction so `.nvmrc`, `.node-version`, and
  `.tool-versions` must resolve inside the workspace before becoming version
  constraint facts.
- Added a regression covering external symlinked `.nvmrc` and `.tool-versions`
  evidence.
- Updated README/STATUS counters to 215 Vitest tests.
- Verification:
  - `npx vitest run test/extract/extractors.test.ts`
  - `npx tsc --noEmit`
  - `npx biome check src test`

### Iteration 64 - workspace-confined editorconfig extraction

- Hardened `.editorconfig` extraction so formatting constraints require config
  evidence that resolves inside the workspace.
- Added a regression for an external symlinked `.editorconfig` that must not
  create an `indent_style` fact.
- Updated README/STATUS counters to 216 Vitest tests.
- Verification:
  - `npx vitest run test/extract/extractors.test.ts`
  - `npx tsc --noEmit`
  - `npx biome check src test`

### Iteration 65 - workspace-confined tsconfig extraction

- Hardened `tsconfig.json` extraction so TypeScript constraints require config
  evidence that resolves inside the workspace.
- Added a regression for an external symlinked `tsconfig.json` that must not
  create a `typescript_strict_mode` fact.
- Updated README/STATUS counters to 217 Vitest tests.
- Verification:
  - `npx vitest run test/extract/extractors.test.ts`
  - `npx tsc --noEmit`
  - `npx biome check src test`

### Iteration 66 - workspace-confined tooling config extraction

- Hardened Biome/ESLint/Prettier config discovery so lint and format facts
  require config evidence that resolves inside the workspace.
- Added a regression for an external symlinked `biome.json` that must not create
  lint or formatter facts.
- Updated README/STATUS counters to 218 Vitest tests.
- Verification:
  - `npx vitest run test/extract/extractors.test.ts`
  - `npx tsc --noEmit`
  - `npx biome check src test`

### Iteration 67 - workspace-confined test config extraction

- Hardened Vitest/Jest/Playwright/Cypress config discovery so test and coverage
  facts require config evidence that resolves inside the workspace.
- Added a regression for an external symlinked `vitest.config.ts` that must not
  create test runner or environment facts.
- Updated README/STATUS counters to 219 Vitest tests.
- Verification:
  - `npx vitest run test/extract/extractors.test.ts`
  - `npx tsc --noEmit`
  - `npx biome check --write src/extract/deterministic/test-config.ts`
  - `npx biome check src test`

### Iteration 68 - workspace-confined Docker and Compose extraction

- Hardened Dockerfile and Compose discovery so container facts require config
  evidence that resolves inside the workspace.
- Added a regression for external symlinked `Dockerfile` and
  `docker-compose.yml` files that must not create container or compose facts.
- Updated README/STATUS counters to 220 Vitest tests.
- Verification:
  - `npx vitest run test/extract/extractors.test.ts`
  - `npx tsc --noEmit`
  - `npx biome check src test`

### Iteration 69 - workspace-confined agent prose extraction

- Hardened AGENTS/CLAUDE/README prose extraction so claim facts require prose
  evidence that resolves inside the workspace.
- Added a regression for an external symlinked `AGENTS.md` that must not create
  low-trust `claims` facts.
- Updated README/STATUS counters to 221 Vitest tests.
- Verification:
  - `npx vitest run test/extract/extractors.test.ts`
  - `npx tsc --noEmit`
  - `npx biome check src test`

### Iteration 70 - workspace-confined CI workflow extraction

- Hardened CI extraction so both `.github/workflows` and each workflow file must
  resolve inside the workspace before creating `ci_command` facts.
- Added a regression covering an external symlinked workflows directory and an
  external symlinked workflow file.
- Updated README/STATUS counters to 222 Vitest tests.
- Verification:
  - `npx vitest run test/extract/extractors.test.ts`
  - `npx tsc --noEmit`
  - `npx biome check --write test/extract/extractors.test.ts`
  - `npx biome check src test`

### Iteration 71 - symlink-safe Claude settings writes

- Hardened Claude Code install/uninstall so symlinked `.claude/settings.json`
  files are refused before read/write mutation, preventing hook install from
  modifying an outside symlink target.
- Added adapters/MCP eval coverage for symlinked Claude settings install and
  uninstall refusal, raising the gate to 78/78 checks.
- Updated STATUS/DEMO adapter/MCP check counters.
- Verification:
  - `npx tsx src/cli.ts eval mcp`
  - `npx tsc --noEmit`
  - `npx biome check src test`

### Iteration 72 - symlink-safe Cursor config writes

- Extracted a shared adapter config-path guard and reused it for Claude and
  Cursor config mutation paths.
- Hardened Cursor install/uninstall so symlinked `.cursor/mcp.json`, rules
  directories, or graphctx rule files are refused before mutation.
- Added adapters/MCP eval coverage for symlinked Cursor `mcp.json` install and
  uninstall refusal, raising the gate to 80/80 checks.
- Updated STATUS/DEMO adapter/MCP check counters.
- Verification:
  - `npx tsx src/cli.ts eval mcp`
  - `npx tsc --noEmit`
  - `npx biome check --write src/adapters/cursor/index.ts`
  - `npx biome check src test`

### Iteration 73 - symlink-safe OpenCode config writes

- Hardened OpenCode install/uninstall so symlinked `opencode.json` files are
  refused before read/write mutation.
- Added adapters/MCP eval coverage for symlinked OpenCode config install and
  uninstall refusal, raising the gate to 82/82 checks.
- Updated STATUS/DEMO adapter/MCP check counters.
- Verification:
  - `npx tsx src/cli.ts eval mcp`
  - `npx tsc --noEmit`
  - `npx biome check src test`

### Iteration 74 - symlink-safe generic adapter marker writes

- Hardened generic adapter install so symlinked `.graphctx`, adapter marker
  directories, or marker files are refused before writing the install marker.
- Added adapters/MCP eval coverage for a symlinked `.graphctx` directory,
  raising the gate to 83/83 checks.
- Updated STATUS/DEMO adapter/MCP check counters.
- Verification:
  - `npx tsx src/cli.ts eval mcp`
  - `npx tsc --noEmit`
  - `npx biome check src test`

### Iteration 75 - symlink-safe AGENTS.md boot capsule writes

- Hardened the AGENTS.md boot capsule writer so symlinked `AGENTS.md` files are
  refused before merge/read/write mutation.
- Added adapters/MCP eval coverage for generic Tier 0 delivery against a
  symlinked `AGENTS.md` target, raising the gate to 84/84 checks.
- Updated STATUS/DEMO adapter/MCP check counters.
- Verification:
  - `npx tsx src/cli.ts eval mcp`
  - `npx tsc --noEmit`
  - `npx biome check src test`

### Iteration 76 - symlink-safe local store paths

- Added a workspace-local store path guard so default `.graphctx` database and
  episode JSONL paths refuse symlinked path components before opening or
  appending to storage outside the workspace.
- Added hook resilience unit coverage and an `eval resilience` gate case proving
  symlinked `.graphctx` stores degrade to empty hook output without writing an
  outside `workspace.db` or `episodes.jsonl`.
- Updated STATUS/README/DEMO counters.
- Verification:
  - `npx vitest run test/resilience/hook-degrades.test.ts`
  - `npx tsx src/cli.ts eval resilience`
  - `npx tsc --noEmit`
  - `npx biome check src test`
  - `npx tsx src/cli.ts eval cli-docs-demo`
  - `npx tsx src/cli.ts eval quality`
  - `git diff --check`

### Iteration 77 - symlink-safe workspace config reads

- Shared symlink path-component detection between config and store safety guards.
- Hardened workspace config loading so symlinked `.graphctx/config.json` paths are
  refused before an outside config can redirect DB or episode storage.
- Added hook resilience unit coverage and an `eval resilience` gate case proving
  symlinked workspace config cannot redirect hook storage outside the repo.
- Updated STATUS/README/DEMO counters.
- Verification:
  - `npx vitest run test/resilience/hook-degrades.test.ts`
  - `npx tsx src/cli.ts eval resilience`
  - `npx tsc --noEmit`
  - `npx biome check src test`
  - `npx tsx src/cli.ts eval cli-docs-demo`
  - `npx tsx src/cli.ts eval quality`
  - `git diff --check`

### Iteration 78 - transcript-tail redaction before retrieval

- Redacted Claude hook transcript tails before they enter `InjectionContext`,
  covering both inline `transcript_tail` payloads and file-backed transcript
  tails.
- Added hook resilience unit coverage and an `eval resilience` gate case proving
  secret-bearing transcript text is redacted before retrieval context.
- Updated STATUS/README/DEMO counters.
- Verification:
  - `npx vitest run test/resilience/hook-degrades.test.ts`
  - `npx tsx src/cli.ts eval resilience`
  - `npx tsc --noEmit`
  - `npx biome check src test`
  - `npx tsx src/cli.ts eval cli-docs-demo`
  - `npx tsx src/cli.ts eval quality`
  - `git diff --check`

### Iteration 79 - hook prompt redaction before retrieval

- Redacted Claude hook prompts before they enter `InjectionContext`, matching
  the existing episode-persistence redaction and the transcript-tail retrieval
  guard.
- Added hook resilience unit coverage and an `eval resilience` gate case proving
  secret-bearing prompts are redacted before retrieval context.
- Updated STATUS/README/DEMO counters.
- Verification:
  - `npx vitest run test/resilience/hook-degrades.test.ts`
  - `npx tsx src/cli.ts eval resilience`
  - `npx tsc --noEmit`
  - `npx biome check src test`
  - `npx tsx src/cli.ts eval cli-docs-demo`
  - `npx tsx src/cli.ts eval quality`
  - `git diff --check`

### Iteration 80 - hook tool-arg redaction before retrieval

- Redacted Claude hook planned tool arguments before they enter
  `InjectionContext`, preventing PreToolUse retrieval query text from seeing
  raw secrets in command args or env payloads.
- Added hook resilience unit coverage and an `eval resilience` gate case proving
  secret-bearing tool args are redacted before retrieval context.
- Updated STATUS/README/DEMO counters.
- Verification:
  - `npx vitest run test/resilience/hook-degrades.test.ts`
  - `npx tsx src/cli.ts eval resilience`
  - `npx tsc --noEmit`
  - `npx biome check src test`
  - `npx tsx src/cli.ts eval cli-docs-demo`
  - `npx tsx src/cli.ts eval quality`
  - `git diff --check`

### Iteration 81 - supported-by temporal evidence edges

- Added a `SUPPORTED_BY` temporal graph edge kind for identical fact evidence
  merges.
- Changed the invalidator's `same` relation to merge evidence counts into the
  existing fact, record `SUPPORTED_BY` / `SUPERSEDED_BY` edges, and retire the
  duplicate fact so redundant active truth does not reach retrieval.
- Added invalidator regression coverage for evidence-count merging, duplicate
  suppression, and edge provenance.
- Updated STATUS/README counters.
- Verification:
  - `npx vitest run test/invalidate/invalidator.test.ts`
  - `npx tsx src/cli.ts eval temporal`
  - `npx tsc --noEmit`
  - `npx biome check src test`
  - `npx tsx src/cli.ts eval cli-docs-demo`
  - `npx tsx src/cli.ts eval quality`
  - `git diff --check`

### Iteration 82 - atomic invalidation effects

- Wrapped each invalidation relation effect in a SQLite transaction so multi-row
  fact/edge updates commit or roll back as a unit.
- Added a rollback regression using a forced `SUPPORTED_BY` edge insert failure,
  proving evidence-count updates and duplicate retirement do not partially
  persist when edge persistence fails.
- Updated STATUS/README counters.
- Verification:
  - `npx vitest run test/invalidate/invalidator.test.ts`
  - `npx tsx src/cli.ts eval temporal`
  - `npx tsc --noEmit`
  - `npx biome check src test`
  - `npx tsx src/cli.ts eval cli-docs-demo`
  - `npx tsx src/cli.ts eval quality`
  - `git diff --check`

### Iteration 83 - MCP prompt redaction before retrieval

- Redacted MCP `recall` queries and `inject_context` prompts before they enter
  retrieval/injection context, matching the Claude hook prompt redaction path.
- Added adapter/MCP gate coverage for both MCP retrieval prompt surfaces.
- Updated STATUS/DEMO adapter/MCP counters to 86/86.
- Verification:
  - `npx tsx src/cli.ts eval mcp`
  - `npx tsc --noEmit`
  - `npx biome check src test`
  - `npx tsx src/cli.ts eval cli-docs-demo`
  - `npx tsx src/cli.ts eval quality`
  - `git diff --check`

### Iteration 84 - shared retrieval-context redaction

- Added a shared retrieval-context sanitizer so CLI recall, MCP recall/inject,
  and Claude hook prompt/transcript surfaces all cross the same redaction and
  hard-cap interface before retrieval planning.
- Switched `graphctx recall` to sanitize secret-shaped query text before
  `InjectionContext`, closing the remaining pull-path prompt leak.
- Added unit coverage for retrieval-context redaction/capping and a core memory
  CLI regression for secret-shaped recall queries, raising the memory gate to
  15/15 checks.
- Updated STATUS/README counters to 231 Vitest tests.
- Verification:
  - `npx vitest run test/security/secrets.test.ts test/resilience/hook-degrades.test.ts`
  - `npx tsx src/cli.ts eval memory`
  - `npx tsx src/cli.ts eval mcp`
  - `npx tsc --noEmit`
  - `npx biome check src/cli.ts src/mcp/tools.ts src/adapters/claude-code/hooks.ts src/security/retrieval-context.ts test/security/secrets.test.ts src/eval/suites/core-memory-lifecycle.ts`
  - `git diff --check`
