import { expect, test } from "bun:test";
import { normaliseForQuote } from "./revision.ts";

test("quotes match through case, whitespace, markdown and JSON escaping", () => {
  const cliJson = String.raw`{"summary":"","sources":[{"content":"**alex**: Let's keep the retry limit at three,\nand log a warning whenever it is reached"}]}`;
  const quote = "Let's keep the retry limit at three, and log a warning whenever it is reached";
  expect(normaliseForQuote(cliJson).includes(normaliseForQuote(quote))).toBe(true);
  expect(normaliseForQuote(cliJson).includes(normaliseForQuote("raise the retry limit whenever it is reached"))).toBe(false);
});
