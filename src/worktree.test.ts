import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createWorktree, NO_PUSH_URL, noPushEnv, removeWorktree } from "./worktree.ts";
import { outwardAction } from "./unblocked-cli.ts";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

function repoWithLocalBranch(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "wt-src-"));
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "base");
  sh(repo, "remote", "add", "origin", "https://github.com/example/repo.git");
  sh(repo, "checkout", "-q", "-b", "someones-wip");
  fs.writeFileSync(path.join(repo, "fix.txt"), "the answer");
  sh(repo, "add", "fix.txt");
  sh(repo, "-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "existing fix");
  sh(repo, "checkout", "-q", "main");
  return repo;
}

test("an arm's clone has the base commit only: no branches to find, no push", () => {
  const repo = repoWithLocalBranch();
  const { path: dir, baseSha } = createWorktree(repo, `t-${process.pid}`, "main");
  try {
    expect(sh(dir, "rev-parse", "HEAD")).toBe(baseSha);
    expect(sh(dir, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes")).toBe("");
    expect(sh(dir, "log", "--all", "--format=%s")).toBe("base");
    expect(sh(dir, "remote", "get-url", "origin")).toBe("https://github.com/example/repo.git");
    expect(sh(dir, "remote", "get-url", "--push", "origin")).toBe(NO_PUSH_URL);
  } finally {
    removeWorktree(repo, `t-${process.pid}`);
  }
  expect(fs.existsSync(dir)).toBe(false);
  expect(sh(repo, "branch", "--list", "someones-wip")).toContain("someones-wip");
});

test("noPushEnv rewrites every push URL, anywhere", () => {
  const repo = repoWithLocalBranch();
  const env = noPushEnv({ PATH: process.env.PATH, HOME: process.env.HOME });
  const pushUrl = execFileSync("git", ["remote", "get-url", "--push", "origin"], { cwd: repo, env, stdio: "pipe" }).toString().trim();
  expect(pushUrl.startsWith(NO_PUSH_URL)).toBe(true);
  // Existing GIT_CONFIG_* entries are kept.
  expect(noPushEnv({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "c" }).GIT_CONFIG_KEY_0).toBe("a.b");
});

test("outwardAction", () => {
  expect(outwardAction("git push -u origin HEAD")).toBe("git push");
  expect(outwardAction("cd x && gh pr create --fill")).toBe("gh pr create");
  expect(outwardAction("gh api repos/o/r/issues/1/comments -f body=hi")).not.toBeNull();
  expect(outwardAction("gh api -X PATCH repos/o/r/pulls/1")).not.toBeNull();
  expect(outwardAction("gh pr view 34076 --comments")).toBeNull();
  expect(outwardAction("gh api repos/o/r/pulls/1/files")).toBeNull();
  expect(outwardAction("gh api -X GET search/issues -f q=x")).toBeNull();
  expect(outwardAction("git log --oneline")).toBeNull();
});
