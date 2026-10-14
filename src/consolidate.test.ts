import { expect, test } from "bun:test";
import { activityProfile, isConsistent, median, readMetrics } from "./consolidate.ts";
import type { ContextEffect } from "./context-effect.ts";
import type { ToolCall } from "./types.ts";

const bash = (command: string): ToolCall => ({ name: "Bash", args: { command }, timestamp: 0, isMcp: false });

test("tool calls are counted by kind", () => {
  const p = activityProfile([
    bash("cd web && npx storybook build"),
    bash("npx playwright screenshot http://localhost:6006"),
    bash("./gradlew :models:test --tests '*StoreTest*'"),
    bash("/tmp/uc-engine-1/bin/unblocked context-research -q x"),
    bash("git log -S foo"),
    { name: "Edit", args: { file_path: "a.ts" }, timestamp: 0, isMcp: false },
    { name: "mcp__unblocked__context_research", args: {}, timestamp: 0, isMcp: true },
  ]);
  expect(p["visual checks (storybook, playwright, screenshots)"]).toBe(2);
  expect(p.tests).toBe(1);
  expect(p.research).toBe(2);
  expect(p["git history"]).toBe(1);
  expect(p.edits).toBe(1);
});

test("median and consistency", () => {
  expect(median([3, -10, 1])).toBe(1);
  expect(median([-12, 4])).toBe(-4);
  expect(isConsistent([-28, -28])).toBe(true);
  expect(isConsistent([-36, 8, -12, -31, 3])).toBe(false);
  expect(isConsistent([-30, -20, -10, 5])).toBe(true);
  expect(isConsistent([-30])).toBe(false);
});

const eff = (b: number, u: number, episodes: ContextEffect["episodes"] = []): ContextEffect => {
  const t = (c: number) => ({ costUsd: c, durationMs: c * 1000, tokens: c * 100 });
  return { baseline: t(b), unblocked: t(u), adjustedBaseline: t(b), adjustedUnblocked: t(b), episodes };
};

test("a consistent difference is the context's, less consistent non-context causes; non-comparable runs drop out", () => {
  const fixLoop = { arm: "unblocked" as const, fromTurn: 1, toTurn: 2, cause: "agent" as const, what: "extra fix round", costUsd: 5, durationMs: 5000, tokens: 500 };
  const effects = [eff(100, 20), eff(100, 70, [fixLoop]), eff(100, 75, [fixLoop])];
  const runs = [{ run: 1, comparable: false, reason: "settings only" }, { run: 2, comparable: true, reason: "" }, { run: 3, comparable: true, reason: "" }];
  const patterns = [{ description: "fix loop", cause: "fix loop" as const, direction: "unblocked-more" as const, runs: [2, 3], consistent: true, evidence: "", episodes: [{ run: 2, episode: 0 }, { run: 3, episode: 0 }] }];
  const [cost] = readMetrics(effects, runs, patterns);
  expect(cost.comparableRuns).toEqual([2, 3]);
  expect(cost.measured).toEqual([-30, -25]);
  expect(cost.carvedOut).toEqual([5, 5]);
  expect(cost.consistent).toBe(true);
  expect(cost.influence).toBe(-32);
  expect(cost.range).toEqual([-35, -30]);
});
