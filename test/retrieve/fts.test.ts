import { describe, expect, it } from "vitest";
import { FTS_TERM_CAP, toFtsMatch } from "../../src/store/facts.repo.js";

describe("FTS query builder", () => {
  it("drops stopwords while preserving meaningful coding terms", () => {
    const match = toFtsMatch("how do I run vitest and typecheck in this repo");
    expect(match).toContain('"vitest"');
    expect(match).toContain('"typecheck"');
    expect(match).toContain('"repo"');
    expect(match).not.toContain('"how"');
    expect(match).not.toContain('"and"');
  });

  it("caps noisy long prompts to a bounded FTS OR expression", () => {
    const noisy = Array.from({ length: FTS_TERM_CAP + 30 }, (_, i) => `signal${i}`).join(" ");
    const match = toFtsMatch(noisy);
    expect(match?.split(" OR ")).toHaveLength(FTS_TERM_CAP);
    expect(match).toContain('"signal0"');
    expect(match).not.toContain(`"signal${FTS_TERM_CAP + 1}"`);
  });
});
