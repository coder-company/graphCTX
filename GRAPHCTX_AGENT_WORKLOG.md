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
