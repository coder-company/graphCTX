import { describe, expect, it } from "vitest";
import {
  EXPECTED_COMMANDS,
  EXPECTED_COMMAND_SET,
  commandsFromHelp,
} from "../../src/eval/command-surface.js";

describe("eval command surface helpers", () => {
  it("keeps the shared expected command set and help parser aligned", () => {
    const help = [
      "Usage: graphctx [options] [command]",
      "",
      "Commands:",
      "  init       create stores",
      "  recall     pull retrieval",
      "  help       display help for command",
      "  eval       run evaluation suites",
    ].join("\n");

    expect(EXPECTED_COMMANDS).toContain("init");
    expect(EXPECTED_COMMANDS).toContain("eval");
    expect(EXPECTED_COMMAND_SET.has("recall")).toBe(true);
    expect(commandsFromHelp(help)).toEqual(["init", "recall", "eval"]);
  });
});
