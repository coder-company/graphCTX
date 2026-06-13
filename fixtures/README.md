# graphCTX eval fixtures

Each `repo-*/` directory is a self-contained sample repository plus a
`scenario.json` describing a scripted coding session for the
**compaction-recovery** suite.

The harness (`src/eval/harness.ts`) copies each repo to a temp dir, runs the
real deterministic extractors, simulates the scripted transcript, forces a
compaction, then replays the post-compaction needs under arms A/B/C:

- **A — no memory:** the agent retains nothing across compaction.
- **B — pull-only:** the agent *may* call `recall`, but does so unreliably
  (model-controlled compliance schedule) — the thesis' core weakness.
- **C — push:** graphCTX pushes a real capsule at `PostCompact`
  (planner → retriever → renderer), guaranteed delivery.

`scenario.json` shape:

```json
{
  "name": "...",
  "needs": [
    { "task": "run tests", "predicate": "test_command",
      "correct": "pnpm test", "wrong": "npm test" }
  ],
  "recall_compliance": [false, false, true, false]
}
```

`needs[*].correct` is the command graphCTX should have learned from repo
structure; `wrong` is what a drifted agent guesses. `recall_compliance[i]`
is whether the agent (in arm B) remembers to call recall for need `i`.
