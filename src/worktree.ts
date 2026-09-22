import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { log } from "./util.ts";
import { git, tryGit } from "./git.ts";

const WORKTREE_BASE = path.join(os.tmpdir(), "unblocked-compare-wt");

export function worktreePath(repoPath: string, name: string): string {
  const repoName = path.basename(repoPath);
  return path.join(WORKTREE_BASE, repoName, name);
}

export function createWorktree(repoPath: string, name: string, branch: string): { path: string; baseSha: string } {
  const wtPath = worktreePath(repoPath, name);
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  git(repoPath, ["worktree", "add", "--detach", wtPath, branch]);
  if (fs.existsSync(path.join(wtPath, ".gitmodules"))) {
    if (tryGit(wtPath, ["submodule", "update", "--init", "--recursive"], "initialising submodules in worktree") !== null) log(`Initialised submodules in ${name}`);
  }
  const baseSha = git(wtPath, ["rev-parse", "HEAD"]).trim();
  return { path: wtPath, baseSha };
}

export function removeWorktree(repoPath: string, name: string, refsBefore: Map<string, string> | null, agentCommits: Set<string>): void {
  const wtPath = worktreePath(repoPath, name);
  if (tryGit(repoPath, ["worktree", "remove", "--force", wtPath], `removing worktree ${name}`) === null) {
    tryGit(repoPath, ["worktree", "prune"], "pruning worktrees");
  }
  if (!refsBefore) { log(`Skipping branch cleanup for ${name}: no ref snapshot from run start`); return; }
  if (agentCommits.size === 0) return;

  const checkedOut = new Set((tryGit(repoPath, ["worktree", "list", "--porcelain"], "listing worktrees") ?? "").split("\n").filter(l => l.startsWith("branch ")).map(l => l.slice(7).trim()));
  const now = tryGit(repoPath, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads"], "listing branches after run") ?? "";
  for (const line of now.split("\n")) {
    const sp = line.indexOf(" ");
    if (sp <= 0) continue;
    const sha = line.slice(0, sp), ref = line.slice(sp + 1), short = ref.replace(/^refs\/heads\//, "");
    if (!agentCommits.has(sha)) continue;
    const before = refsBefore.get(ref);
    if (before === undefined) {
      if (tryGit(repoPath, ["branch", "-D", short], `deleting agent-created branch ${short}`) !== null) log(`Deleted agent-created branch ${short} (was ${sha.slice(0, 7)})`);
    } else if (before !== sha) {
      if (checkedOut.has(ref)) { log(`Agent moved pre-existing branch ${short} to ${sha.slice(0, 7)}, but it is checked out in another worktree; left as is (pre-run sha ${before.slice(0, 7)})`); continue; }
      if (tryGit(repoPath, ["update-ref", ref, before, sha], `resetting ${short} to its pre-run sha`) !== null) {
        log(`Agent moved pre-existing branch ${short} to ${sha.slice(0, 7)}; reset to ${before.slice(0, 7)}. The agent's commit is still reachable by sha for a while.`);
      }
    }
  }
}
