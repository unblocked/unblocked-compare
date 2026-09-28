import { expect, test } from "bun:test";
import { computeContextEffect, reconcile } from "./context-effect.ts";
import type { ComparisonResult } from "./types.ts";

const turn = (n: number, costUsd: number, durationMs: number, label: "work" | "verify" | "housekeeping" = "work") =>
  ({ turn: n, label, repeatOf: null, reason: "", startMs: 0, costUsd, durationMs, modelMs: durationMs, toolMs: 0, stallMs: 0, outputTokens: 100, cacheReadTokens: 900, inputTokens: 0, cacheWriteTokens: 0, summary: "" });
const arm = (turns: ReturnType<typeof turn>[]) => ({ attribution: { turns } }) as unknown as ComparisonResult["baseline"];

test("episodes are summed from core turns; the context effect is baseline plus context-driven differences", () => {
  const result = {
    baseline: arm([turn(1, 0.1, 10_000), turn(2, 0.1, 10_000), turn(3, 0.3, 60_000)]),
    unblocked: arm([turn(1, 0.2, 20_000), turn(2, 0.4, 90_000), turn(3, 0.4, 90_000), turn(4, 0.1, 5_000, "housekeeping")]),
    impact: { episodes: [
      { arm: "baseline", fromTurn: 1, toTurn: 2, cause: "context", what: "explored without context" },
      { arm: "unblocked", fromTurn: 1, toTurn: 1, cause: "context", what: "research call" },
      { arm: "unblocked", fromTurn: 2, toTurn: 3, cause: "agent", what: "test-fix loop" },
      { arm: "unblocked", fromTurn: 3, toTurn: 4, cause: "environment", what: "overlaps T3; T4 is housekeeping" },
    ] },
  } as unknown as ComparisonResult;
  const e = computeContextEffect(result)!;
  expect(e.baseline.costUsd).toBeCloseTo(0.5);
  expect(e.unblocked.costUsd).toBeCloseTo(1.0);                  // housekeeping T4 excluded
  expect(e.episodes.map(x => Math.round(x.costUsd * 10) / 10)).toEqual([0.2, 0.2, 0.8, 0]); // T3 counted once
  expect(e.adjustedBaseline.costUsd).toBeCloseTo(0.5);           // the baseline as is
  // 0.5 + 0.2 (research) - 0.2 (baseline's exploration without context); the loop drops out
  expect(e.adjustedUnblocked.costUsd).toBeCloseTo(0.5);
  expect(e.adjustedUnblocked.durationMs).toBe(80_000 + 20_000 - 20_000);
  expect(e.unblocked.tokens).toBe(3000);
  // The split adds up to the measured difference exactly.
  for (const key of ["costUsd", "durationMs", "tokens"] as const) {
    const r = reconcile(e, key);
    expect(r.influence + r.ownMistakes + r.other).toBeCloseTo(r.measured);
  }
  expect(reconcile(e, "costUsd").ownMistakes).toBeCloseTo(0.8);
});
