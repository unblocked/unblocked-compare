import { expect, test } from "bun:test";
import { unblockedCommand } from "./unblocked-cli.ts";

test("unblockedCommand", () => {
  expect(unblockedCommand(`unblocked context-research --query "x"`)).toEqual({ tool: "context-research", path: "" });
  expect(unblockedCommand(`cd repo && unblocked context_get_urls --url u`)).toEqual({ tool: "context_get_urls", path: "" });
  expect(unblockedCommand(`/var/T/uc-engine-1/bin/unblocked context-research -q x`)).toEqual({ tool: "context-research", path: "/var/T/uc-engine-1/bin/" });
  expect(unblockedCommand(`which unblocked`)).toBeNull();
  expect(unblockedCommand(`unblocked --help`)).toBeNull();
});
