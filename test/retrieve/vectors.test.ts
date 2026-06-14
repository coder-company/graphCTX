import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VectorIndex, distanceToScore } from "../../src/retrieve/vectors.js";
import { runMigrations } from "../../src/store/migrate.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});
afterEach(() => {
  db.close();
});

describe("VectorIndex (local-first semantic retrieval)", () => {
  it("loads sqlite-vec and enables the index", () => {
    const v = new VectorIndex(db, 256);
    expect(v.enabled).toBe(true);
  });

  it("ranks a semantically-matching fact above an unrelated one", () => {
    const v = new VectorIndex(db, 512);
    v.upsert("f_deploy", "repo deploy_command ship canary release production");
    v.upsert("f_indent", "editorconfig indent_style spaces two formatting");
    const hits = v.search("how do I deploy and release to production", 2);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.fact_id).toBe("f_deploy");
  });

  it("is deterministic: same text → same embedding (cache hit)", () => {
    const v = new VectorIndex(db, 128);
    const a = v.embed("run the tests with npm test");
    const b = v.embed("run the tests with npm test");
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("distanceToScore is monotonically decreasing in distance", () => {
    expect(distanceToScore(0)).toBeGreaterThan(distanceToScore(1));
    expect(distanceToScore(1)).toBeGreaterThan(distanceToScore(5));
    expect(distanceToScore(0)).toBeLessThanOrEqual(1);
  });

  it("remove deletes a fact from the index", () => {
    const v = new VectorIndex(db, 128);
    v.upsert("f1", "alpha beta gamma");
    v.remove("f1");
    const hits = v.search("alpha beta gamma", 5);
    expect(hits.find((h) => h.fact_id === "f1")).toBeUndefined();
  });
});
