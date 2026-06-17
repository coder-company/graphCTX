import { describe, expect, it } from "vitest";
import { runStorageMigrationsEval } from "../../src/eval/suites/storage-migrations.js";

describe("storage migrations + corruption recovery", () => {
  it("protects migrations, append-only invariants, pragmas, and degraded reads", () => {
    const r = runStorageMigrationsEval();
    expect(r.migrationsAppliedOnReopen).toBe(0);
    expect(r.pass).toBe(true);
  });
});
