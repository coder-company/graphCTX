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
