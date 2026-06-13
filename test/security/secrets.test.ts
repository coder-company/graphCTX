import { describe, expect, it } from "vitest";
import { containsSecret, scanSecrets } from "../../src/security/secrets.js";
import { trustForSource } from "../../src/security/trust.js";

describe("secret scanning (I3)", () => {
  it("detects API-key-shaped tokens", () => {
    expect(containsSecret("export OPENAI_KEY=sk-abcdefghijklmnopqrstuvwx")).toBe(true);
    expect(containsSecret("AKIAIOSFODNN7EXAMPLE")).toBe(true);
    expect(containsSecret("api_key: 'A1b2C3d4E5f6G7h8'")).toBe(true);
  });

  it("does not flag ordinary command text", () => {
    expect(containsSecret("npm run test")).toBe(false);
    expect(containsSecret("this repo uses pnpm")).toBe(false);
  });

  it("reports the matched pattern name", () => {
    const hits = scanSecrets("token gh" + "p_" + "abcdefghijklmnopqrstuvwxyz0123456789");
    expect(hits.some((h) => h.pattern === "github_token")).toBe(true);
  });
});

describe("trust tiers (I2)", () => {
  it("structured config sources are high trust", () => {
    expect(trustForSource("package.json")).toBe("high");
    expect(trustForSource("lockfile")).toBe("high");
    expect(trustForSource("ci")).toBe("high");
  });

  it("prose sources are low trust", () => {
    expect(trustForSource("agent-files")).toBe("low");
    expect(trustForSource("README.md")).toBe("low");
  });
});
