import { expect, test } from "bun:test";
import { activityProfile, median } from "./consolidate.ts";
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

test("median of odd and even lists", () => {
  expect(median([3, -10, 1])).toBe(1);
  expect(median([-12, 4])).toBe(-4);
});
