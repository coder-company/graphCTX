import { describe, expect, it } from "vitest";
import { runAdaptersMcpEval } from "../../src/eval/suites/adapters-mcp.js";

// M4 gate as a CI test: multi-client install, MCP 8-tool surface (I8), secure
// proxy (opt-in + secret-refusing), telemetry classification.
describe("adapters + MCP (M4 gate)", () => {
  it("installs per client, exposes exactly 8 MCP tools, proxy is secure", async () => {
    const r = await runAdaptersMcpEval();
    expect(r.toolCount).toBe(8);
    expect(r.proxyLeaks).toBe(0);
    expect(r.pass).toBe(true);
  }, 30000);
});
