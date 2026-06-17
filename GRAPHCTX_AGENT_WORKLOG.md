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
