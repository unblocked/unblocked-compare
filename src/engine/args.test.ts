import { describe, expect, test } from "bun:test";
import { parseArgs } from "./args.ts";

describe("parseArgs", () => {
  test("flags", () => {
    expect(parseArgs(["context-research", "--effort", "high", "--query", "why X"])).toEqual({ command: "context-research", query: "why X", effort: "high", urls: [] });
  });
  test("= form, underscores, default effort", () => {
    expect(parseArgs(["context_research", "--query=why X"])).toEqual({ command: "context-research", query: "why X", effort: "low", urls: [] });
  });
  test("positional query", () => {
    expect(parseArgs(["context-research", "--effort", "low", "why", "X"]).query).toBe("why X");
  });
  test("urls: repeated, comma-separated, positional", () => {
    expect(parseArgs(["context-get-urls", "--url", "a", "--urls", "b,c"]).urls).toEqual(["a", "b", "c"]);
    expect(parseArgs(["context_get_urls", "a", "b"]).urls).toEqual(["a", "b"]);
  });
});
