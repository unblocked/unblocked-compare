// Each arm works in its own clone of the repository, not a git worktree. A
// worktree shares the repository's refs, so an agent could list and
// cherry-pick the owner's local branches, or another run's commits (on
// ENG-735 both arms did, copying an existing fix). A `--shared` clone borrows
// the objects (fast, no copy) but keeps only the base commit: no branches, no
// remote-tracking refs. `origin` still names the real remote so `gh` works,
// but pushing is blocked.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { log } from "./util.ts";
import { git, tryGit } from "./git.ts";

const WORKTREE_BASE = path.join(os.tmpdir(), "unblocked-compare-wt");

// A push URL that cannot be reached, so `git push` fails instead of publishing.
export const NO_PUSH_URL = "no-push://unblocked-compare-blocks-pushes";

export function worktreePath(repoPath: string, name: string): string {
  const repoName = path.basename(repoPath);
  return path.join(WORKTREE_BASE, repoName, name);
}

export function createWorktree(repoPath: string, name: string, branch: string): { path: string; baseSha: string } {
  const dir = worktreePath(repoPath, name);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const baseSha = git(repoPath, ["rev-parse", "--verify", `${branch}^{commit}`]).trim();

  git(path.dirname(dir), ["clone", "--shared", "--no-checkout", "--quiet", repoPath, dir]);
  // Only the base commit is reachable by name.
  const refs = git(dir, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes"]).split("\n").filter(Boolean);
  if (refs.length) git(dir, ["update-ref", "--no-deref", "--stdin"], undefined, refs.map(r => `delete ${r}\n`).join(""));
  git(dir, ["checkout", "--quiet", "--detach", baseSha]);

  const originUrl = tryGit(repoPath, ["remote", "get-url", "origin"], "reading the origin url")?.trim();
  if (originUrl) {
    git(dir, ["remote", "set-url", "origin", originUrl]);
    git(dir, ["config", "remote.origin.pushurl", NO_PUSH_URL]);
  } else {
    git(dir, ["remote", "remove", "origin"]);
  }

  if (fs.existsSync(path.join(dir, ".gitmodules"))) initSubmodules(repoPath, dir, name);
  return { path: dir, baseSha };
}

// Submodules come from the repository's own checked-out copies where it has
// them (local, hardlinked), not from the network.
function initSubmodules(repoPath: string, dir: string, name: string): void {
  const entries = (tryGit(dir, ["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"], "listing submodules") ?? "").split("\n").filter(Boolean);
  for (const line of entries) {
    const [key, subPath] = line.split(/\s+/);
    const subName = key.replace(/^submodule\./, "").replace(/\.path$/, "");
    const local = tryGit(path.join(repoPath, subPath), ["rev-parse", "--absolute-git-dir"], `locating submodule ${subPath}`)?.trim();
    if (local && fs.existsSync(local)) git(dir, ["config", `submodule.${subName}.url`, local]);
  }
  // Local-path submodule URLs need file transport, off by default since git 2.38.
  if (tryGit(dir, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive", "--quiet"], "initialising submodules") !== null) log(`Initialised submodules in ${name}`);
}

// The clone holds everything the agent did; the repository itself was never
// touched, so there is nothing to reset there.
export function removeWorktree(repoPath: string, name: string): void {
  const dir = worktreePath(repoPath, name);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    log(`Could not remove ${dir}: ${(err as Error).message}`);
  }
}

// Git configuration for every agent process (arms and research agents),
// passed through the environment so it holds in any directory, including the
// original repository the simulated engine researches in: a push to any
// remote URL is rewritten to one that cannot be reached.
const PUSH_URL_PREFIXES = ["https://", "http://", "ssh://", "git@", "git://"];
export function noPushEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const start = parseInt(base.GIT_CONFIG_COUNT ?? "0", 10) || 0;
  const env: NodeJS.ProcessEnv = { ...base, GIT_CONFIG_COUNT: String(start + PUSH_URL_PREFIXES.length) };
  PUSH_URL_PREFIXES.forEach((prefix, i) => {
    env[`GIT_CONFIG_KEY_${start + i}`] = `url.${NO_PUSH_URL}/.pushInsteadOf`;
    env[`GIT_CONFIG_VALUE_${start + i}`] = prefix;
  });
  return env;
}
