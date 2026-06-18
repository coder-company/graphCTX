import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixedClock } from "../../src/core/clock.js";
import { runTelemetryLearningEval } from "../../src/eval/suites/telemetry-learning.js";
import { openDb } from "../../src/store/db.js";
import { InjectionsRepo } from "../../src/store/injections.repo.js";
import { OutcomeRecorder, type OutcomeSignal } from "../../src/telemetry/outcomes.js";

describe("telemetry learning eval", () => {
  it("protects classifier accuracy, learned ranking, local-only recording, and ledger behavior", () => {
    const r = runTelemetryLearningEval();
    expect(r.classificationAccuracy).toBeGreaterThanOrEqual(r.classificationThreshold);
    expect(r.learnedMetric).toBeGreaterThan(r.baselineMetric);
    expect(r.networkCalls).toBe(0);
    expect(r.pass).toBe(true);
  });

  it("persists only whitelisted outcome signal booleans", () => {
    const dir = mkdtempSync(join(tmpdir(), "graphctx-telemetry-unit-"));
    const db = openDb(join(dir, "telemetry.db"));
    try {
      const clock = fixedClock("2026-01-01T00:00:00.000Z");
      const repo = new InjectionsRepo(db, clock);
      const id = repo.log({
        session_id: "s-unit",
        event_type: "PostToolUse",
        selected_fact_ids: ["fact_unit"],
        token_count: 4,
      });
      const secret = "ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";
      const signal = {
        followedBySuccess: true,
        repeatedFailure: false,
        command: `curl -H 'Authorization: Bearer ${secret}' https://example.invalid`,
        token: secret,
        nested: { api_key: secret },
      } as OutcomeSignal & Record<string, unknown>;

      const outcome = new OutcomeRecorder(db, { clock }).record(id, signal);
      const row = db
        .prepare("SELECT outcome_json FROM injections WHERE injection_id = ?")
        .get(id) as { outcome_json: string };
      const parsed = JSON.parse(row.outcome_json) as {
        at: string;
        signals: Record<string, unknown>;
      };

      expect(outcome).toBe("helped");
      expect(parsed.at).toBe("2026-01-01T00:00:00.000Z");
      expect(parsed.signals).toEqual({ followedBySuccess: true });
      expect(row.outcome_json).not.toContain(secret);
      expect(row.outcome_json).not.toContain("Authorization");
      expect(row.outcome_json).not.toContain("api_key");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
