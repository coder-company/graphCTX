export const EVAL_GATE_SUITES = [
  "run",
  "memory",
  "promote",
  "drift",
  "retrieval",
  "gate",
  "security",
  "branch",
  "temporal",
  "conflict",
  "procedure",
  "mcp",
  "storage",
  "telemetry",
  "provenance",
  "resilience",
  "benchmarks",
  "cli-docs-demo",
  "quality",
] as const;

export type EvalGateSuite = (typeof EVAL_GATE_SUITES)[number];

export function isEvalGateSuite(s: string): s is EvalGateSuite {
  return (EVAL_GATE_SUITES as readonly string[]).includes(s);
}

export function evalSubcommandHelp(): string {
  return `subcommand: ${EVAL_GATE_SUITES.join(" | ")} | all`;
}
