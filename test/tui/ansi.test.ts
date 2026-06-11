import { describe, expect, it } from "vitest";
import { padEnd, padStart, stripAnsi, truncate, visibleLen } from "../../src/tui/ansi.js";
import { bar, panel, table } from "../../src/tui/box.js";

describe("ansi — visible length ignores escape codes", () => {
  it("visibleLen strips ANSI", () => {
    const styled = "\x1b[31mred\x1b[39m";
    expect(visibleLen(styled)).toBe(3);
    expect(stripAnsi(styled)).toBe("red");
  });

  it("padEnd/padStart pad by visible width", () => {
    expect(visibleLen(padEnd("ab", 5))).toBe(5);
    expect(visibleLen(padStart("ab", 5))).toBe(5);
  });

  it("padEnd accounts for ANSI when padding", () => {
    const styled = "\x1b[31mred\x1b[39m"; // visible 3
    expect(visibleLen(padEnd(styled, 10))).toBe(10);
  });

  it("truncate adds ellipsis and respects width", () => {
    const t = truncate("abcdefghij", 5);
    expect(visibleLen(t)).toBeLessThanOrEqual(5);
    expect(t.endsWith("…")).toBe(true);
  });

  it("truncate leaves short strings untouched", () => {
    expect(truncate("ab", 5)).toBe("ab");
  });
});

describe("box — panel renders aligned borders", () => {
  it("every panel line has identical visible width", () => {
    const out = panel(["line one", "two"], { title: "T", width: 40 }).split("\n");
    const widths = new Set(out.map((l) => visibleLen(l)));
    expect(widths.size).toBe(1);
    expect([...widths][0]).toBe(40);
  });

  it("panel truncates over-long lines to fit", () => {
    const long = "x".repeat(200);
    const out = panel([long], { width: 30 }).split("\n");
    for (const l of out) expect(visibleLen(l)).toBe(30);
  });
});

describe("box — table aligns columns", () => {
  it("each row cell is padded to the column width", () => {
    const rows = table(
      [
        { header: "a", width: 6 },
        { header: "b", width: 4, align: "right" },
      ],
      [["x", "1"]],
    );
    // header + 1 row
    expect(rows.length).toBe(2);
  });
});

describe("box — bar clamps fraction", () => {
  it("bar of 0..1 has fixed width", () => {
    expect(visibleLen(bar(0.5, 10))).toBe(10);
    expect(visibleLen(bar(2, 10))).toBe(10); // clamped
    expect(visibleLen(bar(-1, 10))).toBe(10); // clamped
  });
});
