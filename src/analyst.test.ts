import { expect, test } from "bun:test";
import { neutralise, neutraliseCode } from "./analyst.ts";

test("code keeps product words and every line; only tool identifiers are renamed", () => {
  const line = '+        description: `"${variable.name}" will no longer be available to Unblocked Code.`,';
  expect(neutraliseCode(line)).toBe(line);
  expect(neutralise(line)).toBe(line);
  expect(neutraliseCode("+ call mcp__unblocked__context_research, then `unblocked context-research -q x`"))
    .toBe("+ call research_tool, then `research_tool -q x`");
});

test("prose hides use of the research tool and drops sentences saying it was not used", () => {
  expect(neutralise("Unblocked's context showed the decision.")).toBe("the research tool showed the decision.");
  expect(neutralise("I queried Unblocked for prior PRs.")).toBe("I queried the research tool for prior PRs.");
  expect(neutralise("Found it in git history.\nI did not use the Unblocked MCP tools.\nTests pass.")).toBe("Found it in git history.\n\nTests pass.");
});

test("prose keeps the product name where it is not about the tool", () => {
  expect(neutralise("Variables are no longer sent to Unblocked Code.")).toBe("Variables are no longer sent to Unblocked Code.");
});
