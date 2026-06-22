export const EXPECTED_COMMANDS = [
  "init",
  "install",
  "uninstall",
  "hook",
  "recall",
  "remember",
  "loop",
  "resolve",
  "extract",
  "serve",
  "why",
  "doctor",
  "demo",
  "skill",
  "tui",
  "compare",
  "bench",
  "eval",
] as const;

export type ExpectedCommand = (typeof EXPECTED_COMMANDS)[number];

export const EXPECTED_COMMAND_SET = new Set<string>(EXPECTED_COMMANDS);

export function commandsFromHelp(help: string): string[] {
  const commands = new Set<string>();
  for (const line of help.split("\n")) {
    const m = line.match(/^\s{2}([a-z][a-z-]*)\b/);
    if (m?.[1] && m[1] !== "help") commands.add(m[1]);
  }
  return [...commands];
}
