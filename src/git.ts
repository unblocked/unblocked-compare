import { execFileSync } from "node:child_process";
import { log } from "./util.ts";

const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

export function git(cwd: string, args: string[], maxBuffer = DEFAULT_MAX_BUFFER): string {
  return execFileSync("git", ["-c", "core.quotePath=false", ...args], { cwd, stdio: "pipe", maxBuffer }).toString();
}

export function tryGit(cwd: string, args: string[], what: string): string | null {
  try {
    return git(cwd, args);
  } catch (err) {
    log(`git ${args[0]} failed while ${what}: ${(err as Error).message.split("\n")[0]}`);
    return null;
  }
}

export function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

export function snapshotRefs(repoPath: string): Map<string, string> | null {
  const out = tryGit(repoPath, ["for-each-ref", "--format=%(objectname) %(refname)"], "snapshotting refs");
  if (out === null) return null;
  const refs = new Map<string, string>();
  for (const line of out.split("\n")) {
    const sp = line.indexOf(" ");
    if (sp > 0) refs.set(line.slice(sp + 1), line.slice(0, sp));
  }
  return refs;
}

export function refsContaining(cwd: string, sha: string): Map<string, string> {
  const refs = new Map<string, string>();
  const out = tryGit(cwd, ["for-each-ref", "--contains", sha, "--format=%(objectname) %(refname)"], `listing refs containing ${sha.slice(0, 7)}`);
  for (const line of (out ?? "").split("\n")) {
    const sp = line.indexOf(" ");
    if (sp > 0) refs.set(line.slice(sp + 1), line.slice(0, sp));
  }
  return refs;
}

export function commitsBetween(cwd: string, from: string, to: string): number {
  const out = tryGit(cwd, ["rev-list", "--count", `${from}..${to}`], `counting commits ${from.slice(0, 7)}..${to.slice(0, 7)}`);
  return out === null ? 0 : parseInt(out.trim(), 10) || 0;
}
