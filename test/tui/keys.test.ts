import { describe, expect, it } from "vitest";
import { decodeKey, decodeKeyChunk } from "../../src/tui/keys.js";

describe("tui/keys — escape sequence decoding", () => {
  it("decodes paging and jump keys from common terminal sequences", () => {
    expect(decodeKey("\x1b[5~").name).toBe("pageup");
    expect(decodeKey("\x1b[6~").name).toBe("pagedown");
    expect(decodeKey("\x1b[H").name).toBe("home");
    expect(decodeKey("\x1b[1~").name).toBe("home");
    expect(decodeKey("\x1b[F").name).toBe("end");
    expect(decodeKey("\x1b[4~").name).toBe("end");
  });

  it("splits chunked key input without swallowing adjacent escape sequences", () => {
    expect(decodeKeyChunk("\x1b[A\x1b[Bjk").map((k) => k.name)).toEqual(["up", "down", "j", "k"]);
    expect(decodeKeyChunk("\x1b[5~\x1b[6~").map((k) => k.name)).toEqual(["pageup", "pagedown"]);
  });
});
