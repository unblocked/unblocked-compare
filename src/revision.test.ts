import { expect, test } from "bun:test";
import { normaliseForQuote } from "./revision.ts";

test("quotes match through case, whitespace, markdown and JSON escaping", () => {
  const cliJson = String.raw`{"summary":"","sources":[{"content":"**martin**: I think the fix is just detecting PR state,\nand use default branch whenever it was merged/closed"}]}`;
  const quote = "I think the fix is just detecting PR state, and use default branch whenever it was merged/closed";
  expect(normaliseForQuote(cliJson).includes(normaliseForQuote(quote))).toBe(true);
  expect(normaliseForQuote(cliJson).includes(normaliseForQuote("use the PR branch whenever it was merged"))).toBe(false);
});
