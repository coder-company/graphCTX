# Contributing to graphCTX

Thanks for your interest in improving graphCTX. This document covers local
development setup, the green bar we run before merging, and the conventions
used throughout the repository.

## Ground Rules

- Open an issue before sending large changes so we can discuss scope.
- Keep pull requests focused and small. Multiple small PRs land faster than
  one large one.
- Do not commit secrets, real API keys, or generated databases. The
  `.gitignore` already excludes the usual suspects (`.env`, `*.db`,
  `.graphctx/`, `dist/`, etc).

## Development Setup

graphCTX requires **Node.js 20+**.

```bash
git clone https://github.com/coder-company/graphCTX.git
cd graphCTX
npm install
npx tsx src/cli.ts --help
```

Run the CLI from source during development:

```bash
npx tsx src/cli.ts <command>
# or
npm run dev -- <command>
```

Compile the TypeScript package:

```bash
npm run build
```

## Local Green Bar

Run all of these before opening a pull request:

```bash
npx tsc --noEmit                  # type-check
npx biome check src test          # lint and format
npx vitest run                    # unit and integration tests
npx tsx src/cli.ts eval all       # offline eval gates
npx tsx src/cli.ts bench          # hot-path latency budget
```

Optionally, exercise the packaged tarball end-to-end:

```bash
npm run pack:smoke
```

## Coding Conventions

- **Language:** TypeScript, ESM, Node 20+.
- **Style:** Biome with the config in [`biome.json`](biome.json). Run
  `npm run lint:fix` and `npm run format` to auto-fix issues.
- **Imports:** Always use the `node:` import protocol for builtins.
- **Tests:** Co-locate new tests with the suite that exercises the feature
  under `test/`. Prefer deterministic fixtures over network calls.
- **Comments:** Add only the minimum comments needed to explain non-obvious
  behavior. The code itself should read clearly.
- **Local-first:** Any new feature must degrade cleanly when LLM keys, git
  metadata, or external services are missing. graphCTX should never break the
  host agent.

## Commit Messages

Use short, imperative commit subjects (~50 characters) describing the change,
matching the existing history:

```
Add tox and nox harness extractors
Guard MCP status counters
Bound TUI prompt rendering
```

Keep the body, if any, focused on *why* the change is needed.

## Pull Requests

Before requesting a review:

1. Confirm the local green bar passes.
2. Add or update tests covering the change.
3. Update relevant docs in `docs/` and the top-level `README.md` if behavior
   changes.
4. Reference any related issues in the PR description.

## Reporting Security Issues

Please do not file public issues for security problems. Follow the process in
[SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions will be licensed under the
[MIT License](LICENSE).
