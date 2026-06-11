import { describe, expect, it } from "vitest";
import { formatReport, multiAxis, runBenchmark } from "../../src/bench/compare.js";
import { SupermemoryClient } from "../../src/bench/supermemory.js";

describe("bench — multi-axis scorecard", () => {
  it("includes the core differentiating axes", () => {
    const axes = multiAxis();
    const names = axes.map((a) => a.axis);
    expect(names).toContain("Delivery model");
    expect(names).toContain("Offline capable");
    expect(names).toContain("Temporal validity");
    // push vs pull is the thesis
    const delivery = axes.find((a) => a.axis === "Delivery model");
    expect(delivery?.graphctx.toLowerCase()).toContain("push");
    expect(delivery?.supermemory.toLowerCase()).toContain("pull");
  });

  it("offline runBenchmark returns axes and skips live without a key", async () => {
    const report = await runBenchmark({ live: false });
    expect(report.axes.length).toBeGreaterThan(5);
    expect(report.live).toBeUndefined();
    const text = formatReport(report);
    expect(text).toContain("multi-axis scorecard");
  });
});

describe("bench — supermemory client guards the key", () => {
  it("available() reflects env presence", () => {
    const had = process.env.SUPERMEMORY_API_KEY;
    process.env.SUPERMEMORY_API_KEY = "";
    expect(SupermemoryClient.available()).toBe(false);
    if (had) process.env.SUPERMEMORY_API_KEY = had;
  });

  it("constructing without a key throws (never silently runs)", () => {
    const had = process.env.SUPERMEMORY_API_KEY;
    process.env.SUPERMEMORY_API_KEY = "";
    expect(() => new SupermemoryClient()).toThrow(/SUPERMEMORY_API_KEY/);
    if (had) process.env.SUPERMEMORY_API_KEY = had;
  });
});
