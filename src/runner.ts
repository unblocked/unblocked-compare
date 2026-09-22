import { execSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ArmResult, ComparisonResult, Condition, Config, DiffStats, ReviewPass, ReviewRound, ReviewSpec, RunResult, TokenUsage, UnblockedCall } from "./types.ts";
import { runClaude, createWorktree, removeWorktree } from "./claude.ts";
import { printReport, writeJsonResult, writeHtmlReport, writeBatchSummary } from "./report.ts";
import { estimateCost, formatCost, formatDiffSummary, formatDuration, log } from "./util.ts";
import { git, isAncestor, snapshotRefs, tryGit } from "./git.ts";
import { attribute } from "./attribution.ts";
import { applyTieBreaker, assessQuality } from "./quality.ts";
import { assessImpact } from "./impact.ts";
import { economics } from "./economics.ts";
import { adjudicateDisputes, applyWaivers, disputedSection, extractRequirements, fixPrompt, reviewDraft } from "./review.ts";

export function agentCommits(cwd: string, baseSha: string, refsBefore: Map<string, string> | null): Set<string> {
  const heads = new Set<string>();
  const head = tryGit(cwd, ["rev-parse", "HEAD"], "resolving HEAD")?.trim();
  if (head) heads.add(head);
  for (const sha of (tryGit(cwd, ["reflog", "show", "--format=%H", "HEAD"], "reading worktree reflog") ?? "").split("\n")) if (sha.trim()) heads.add(sha.trim());
  if (heads.size === 0) return new Set();
  const remoteTips = (tryGit(cwd, ["for-each-ref", "--format=%(objectname)", "refs/remotes"], "listing remote refs") ?? "").split("\n").map(l => l.trim()).filter(Boolean);
  const exclude = new Set<string>([baseSha, ...(refsBefore ? refsBefore.values() : []), ...remoteTips]);
  const out = tryGit(cwd, ["rev-list", ...heads, "--not", ...exclude], "listing agent commits");
  return new Set((out ?? "").split("\n").map(l => l.trim()).filter(Boolean));
}

function latestAgentTip(cwd: string, baseSha: string, agent: Set<string>): string | null {
  for (const raw of (tryGit(cwd, ["reflog", "show", "--format=%H", "HEAD"], "reading worktree reflog") ?? "").split("\n")) {
    const sha = raw.trim();
    if (sha && agent.has(sha) && isAncestor(cwd, baseSha, sha)) return sha;
  }
  return null;
}

interface Captured { diff: string; stats: DiffStats }

function numstatTotals(numstat: string): { files: number; added: number; removed: number } {
  let files = 0, added = 0, removed = 0;
  for (const line of numstat.split("\n")) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t/);
    if (!m) continue;
    files++;
    if (m[1] !== "-") added += parseInt(m[1], 10);
    if (m[2] !== "-") removed += parseInt(m[2], 10);
  }
  return { files, added, removed };
}

export function captureDiff(cwd: string, baseSha: string, refsBefore: Map<string, string> | null): Captured & { agent: Set<string> } {
  const agent = agentCommits(cwd, baseSha, refsBefore);
  const fail = (diff: string): Captured & { agent: Set<string> } => ({ diff, stats: { filesChanged: 0, linesAdded: 0, linesRemoved: 0, commits: 0 }, agent });

  const head = tryGit(cwd, ["rev-parse", "HEAD"], "resolving HEAD for diff capture")?.trim();
  if (!head) return fail("(failed to capture diff)");
  const dirty = (tryGit(cwd, ["status", "--porcelain"], "checking working tree") ?? "").trim().length > 0;
  const countIn = (tip: string) => (tryGit(cwd, ["rev-list", `${baseSha}..${tip}`], "counting agent commits") ?? "").split("\n").filter(l => agent.has(l.trim())).length;

  let range: string[];
  let commits: number;
  let includeWorkingTree: boolean;
  if (agent.has(head)) {
    range = [baseSha]; commits = countIn(head); includeWorkingTree = true;
  } else if (dirty) {
    if (agent.size) log(`Worktree HEAD ${head.slice(0, 7)} is not an agent commit and the tree is dirty; reporting uncommitted changes (${agent.size} agent commit(s) in the reflog are not in the diff)`);
    range = [head]; commits = 0; includeWorkingTree = true;
  } else {
    const tip = latestAgentTip(cwd, baseSha, agent);
    if (tip) { range = [baseSha, tip]; commits = countIn(tip); includeWorkingTree = false; }
    else { range = [head]; commits = 0; includeWorkingTree = true; }
  }

  const numstat = tryGit(cwd, ["diff", "--numstat", ...range], "computing diff stats");
  if (numstat === null) return fail("(failed to capture diff)");
  const totals = numstatTotals(numstat);

  const noIndex = (file: string, extra: string[]): string | null => {
    try { git(cwd, ["diff", "--no-index", ...extra, "/dev/null", file]); return ""; } catch (e) {
      const err = e as { status?: number | null; code?: string; stdout?: Buffer };
      if (err.status === 1) return err.stdout?.toString() ?? "";
      log(`git diff --no-index failed for ${file}: ${err.code ?? `exit ${err.status}`}`);
      return null;
    }
  };
  const untracked = includeWorkingTree
    ? (tryGit(cwd, ["ls-files", "-z", "--others", "--exclude-standard"], "listing untracked files") ?? "").split("\0").filter(Boolean)
    : [];
  for (const file of untracked) {
    const t = numstatTotals(noIndex(file, ["--numstat"]) ?? "");
    totals.files += t.files; totals.added += t.added; totals.removed += t.removed;
  }

  const stats: DiffStats = { filesChanged: totals.files, linesAdded: totals.added, linesRemoved: totals.removed, commits };

  let text: string;
  try {
    text = git(cwd, ["diff", ...range]);
  } catch (e) {
    const err = e as { code?: string; status?: number | null };
    if (err.code === "ENOBUFS") {
      log("Diff text too large to keep; stats are still exact");
      text = `(diff text too large to keep: ${formatDiffSummary(stats)})`;
      stats.truncated = true;
    } else {
      log(`git diff failed: ${err.code ?? `exit ${err.status}`}`);
      return { ...fail("(failed to capture diff)"), stats };
    }
  }
  if (!stats.truncated) {
    for (const file of untracked) {
      const part = noIndex(file, []);
      if (part === null) { text += `\n(diff for ${file} unavailable)\n`; continue; }
      text += part;
    }
  }
  return { diff: text || "(no changes)", stats, agent };
}

export function extractUnblockedCalls(toolCalls: { name: string; args: Record<string, unknown>; mcpServer?: string }[]): UnblockedCall[] {
  const calls: UnblockedCall[] = [];
  for (const tc of toolCalls) {
    const isUbMcp = tc.mcpServer?.toLowerCase().includes("unblocked")
      || tc.name.toLowerCase().includes("unblocked");
    const isUbCli = tc.name === "Bash"
      && /^unblocked\s+context[_-]/.test((tc.args.command as string) ?? "");

    if (isUbMcp) {
      const tool = tc.name.split(/__|::/).pop() ?? tc.name;
      const query = (tc.args.query as string) ?? (tc.args.url as string) ?? (tc.args.urls as string);
      calls.push({ tool, query: query ?? undefined });
    } else if (isUbCli) {
      const cmd = (tc.args.command as string) ?? "";
      const match = cmd.match(/^unblocked\s+(context[_-]\w+)/);
      if (match) {
        const tool = match[1];
        const queryFlag = cmd.match(/--query\s+["']?(.+?)["']\s*(?:--|$)/)?.[1];
        const positional = cmd.match(/(?:--effort\s+\w+\s+)?["']([^"']+)["']\s*$/)?.[1]
          ?? cmd.match(/(?:--effort\s+\w+\s+)(\S.+)$/)?.[1];
        calls.push({ tool, query: queryFlag ?? positional ?? undefined });
      }
    }
  }
  return calls;
}

const RESEARCH_DISCIPLINE = `How to research, whatever tools you use:
- Before writing code, look for the convention this organisation already uses for this class of problem: prior art in this repository, in other repositories, in build images and shared actions, in docs, tickets and past discussions.
- After planning, check for operational risks, previous incidents, deployment gotchas and rejected approaches related to your plan. Before implementing an unfamiliar pattern, verify conventions and team decisions.
- A search that returns nothing is not a finding. If a source returns nothing on a question that matters, check a second source before concluding that nothing exists: a code search across the organisation's repositories, the file a comment or ticket points at, a runbook.
- Do not end your turn while a command you started in the background is still running: wait for it, read its output, and report the result.
- For a build, test suite or other command that takes more than a minute or so, choose one of two ways to wait, never a third: (a) if you have other useful work ready right now (reading a different file, writing a test for a part you already understand), background the command and do that work, then check its result when you circle back; (b) if you do not, issue ONE command that waits for it to finish (poll in a loop inside that single call, e.g. \`for i in $(seq 1 40); do grep -q EXIT= log && break; sleep 15; done; cat log\`) and treat its return as the answer. Never issue a separate tool call per check (\`tail log\`, again, again): each one is a full turn, so ten checks cost ten times what one wait does, and checking on nothing to do costs the most of all.
- Your final response is the PR description a reviewer will read: what changed, what you verified and how, and any part of the task you deliberately left out, with the reason. Say where each decisive fact came from, and say plainly when you are inferring.`;

const BASELINE_NUDGE = `IMPORTANT: Do NOT use any Unblocked tools, Unblocked skills, or Unblocked CLI commands. Do NOT call context_research, context_get_urls, or any tool with "unblocked" in its name. Do NOT run the "unblocked" CLI binary. You may use all other tools, MCP servers, plugins, and skills, including code search across the organisation's repositories.

${RESEARCH_DISCIPLINE}

TASK:
`;

const UNBLOCKED_MCP_NUDGE = `IMPORTANT: Before doing anything else, call the Unblocked context_research MCP tool with a detailed query describing the task (effort: low). This is your FIRST action. Use context_research again (effort: low) at the points below, and context_get_urls to expand on anything it surfaces. You may also use all other tools, MCP servers, plugins, and skills.

${RESEARCH_DISCIPLINE}

TASK:
`;

const UNBLOCKED_CLI_NUDGE = `IMPORTANT: Before doing anything else, run the Unblocked CLI to research this task. This is your FIRST action:
unblocked context-research --effort low --query "<detailed query describing the task>"
Use context-research again (--effort low) at the points below, and context-get-urls to expand on anything it surfaces. You may also use all other tools, MCP servers, plugins, and skills.

${RESEARCH_DISCIPLINE}

TASK:
`;

function warnIfBehindUpstream(repo: string, branch: string): void {
  if (tryGit(repo, ["fetch", "--quiet", "origin"], "fetching origin to check the base") === null) return;
  if (/^(origin|refs\/remotes)\//.test(branch)) return;
  let upstream: string | null = null;
  try { upstream = git(repo, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]).trim(); } catch { /* no upstream configured */ }
  upstream ??= tryGit(repo, ["rev-parse", "--verify", "--quiet", "origin/main"], "checking origin/main") ? "origin/main" : null;
  if (!upstream) return;
  const behind = parseInt(tryGit(repo, ["rev-list", "--count", `${branch}..${upstream}`], "counting commits behind upstream")?.trim() ?? "0", 10) || 0;
  if (behind > 0) log(`⚠ Base ${branch} is ${behind} commit(s) behind ${upstream}. If the task's fix has already landed upstream, both arms will find it and the comparison measures something else. Pass --branch ${upstream} to run against the tip.`);
}

function keepMachineAwake(): void {
  if (process.platform !== "darwin") return;
  try {
    const child = spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
    child.on("error", err => log(`caffeinate unavailable (${err.message}); the machine may sleep during the run`));
    child.unref();
  } catch (err) {
    log(`caffeinate unavailable (${(err as Error).message}); the machine may sleep during the run`);
  }
}

interface RunContext {
  agentCommitsByArm: Map<Condition, Set<string>>;
  worktreeByArm: Map<Condition, string>;
  reviewSpec: ReviewSpec | null;
}

async function runArm(config: Config, condition: Condition, outDir: string, refsBefore: Map<string, string> | null, ctx: RunContext): Promise<ArmResult> {
  let nudge: string;
  if (condition === "baseline") {
    nudge = BASELINE_NUDGE;
  } else if (config.cliMode) {
    nudge = UNBLOCKED_CLI_NUDGE;
  } else {
    nudge = UNBLOCKED_MCP_NUDGE;
  }
  const prompt = nudge + config.task;

  const suffix = randomBytes(4).toString("hex");
  const wtName = `${condition}-${suffix}`;

  log(`[${condition}] Creating worktree: ${wtName}`);
  const { path: wtPath, baseSha } = createWorktree(config.repo, wtName, config.branch);
  ctx.worktreeByArm.set(condition, wtName);
  log(`[${condition}] Worktree at: ${wtPath} (base ${baseSha.slice(0, 7)})`);

  let spentMs = 0;
  const remainingMs = () => Math.max(60_000, config.timeoutSeconds * 1000 - spentMs);

  log(`[${condition}] Running Claude Code...`);
  const runResult = await runClaude({
    prompt,
    worktreePath: wtPath,
    model: config.model,
    condition,
    timeoutMs: remainingMs(),
    outDir,
    blockUnblocked: condition === "baseline",
  });
  spentMs += runResult.durationMs;
  log(`[${condition}] Done: ${formatDuration(runResult.durationMs)}, ${runResult.assistantTurns} turns, exit=${runResult.exitCode}${runResult.timedOut ? " (TIMED OUT)" : ""}${runResult.killedReason && !runResult.timedOut ? ` (killed: ${runResult.killedReason})` : ""}`);

  let { diff, stats: diffStats, agent } = captureDiff(wtPath, baseSha, refsBefore);
  log(`[${condition}] Diff: ${formatDiffSummary(diffStats)}`);

  let run: RunResult = { ...runResult, worktreePath: wtPath };
  let review: ReviewRound | undefined;

  if (config.reviewRounds > 0 && run.assistantTurns === 0) {
    log(`[${condition}] Review: skipped, the run produced no messages (exit ${run.exitCode})`);
  } else if (config.reviewRounds > 0 && ctx.reviewSpec) {
    const spec = ctx.reviewSpec;
    const draftCost = run.totalCostUsd ?? estimateCost(config.model, run.tokenUsage);
    review = { maxRounds: config.reviewRounds, passes: [], draft: { diffStats, costUsd: draftCost, durationMs: run.durationMs, messages: run.assistantTurns }, finalMergeable: false };
    const draftPath = path.join(outDir, `${condition}.draft.jsonl`);
    fs.copyFileSync(run.jsonlPath, draftPath);
    let disputed = "";
    const toPass = (round: number, r: NonNullable<Awaited<ReturnType<typeof reviewDraft>>>): ReviewPass =>
      ({ round, reviewModel: r.model, reviewCostUsd: r.costUsd, mergeable: r.mergeable, summary: r.summary, requirements: r.requirements, waiversInForce: r.waiversInForce, before: diffStats, fix: null });
    for (let round = 1; round <= config.reviewRounds; round++) {
      const armNow: ArmResult = { condition, run, diff, diffStats, unblockedCalls: [], estimatedCost: run.totalCostUsd ?? estimateCost(config.model, run.tokenUsage) };
      const prev = review.passes[review.passes.length - 1] ?? null;
      const r = await reviewDraft(config.task, armNow, config.checkerModel, round, prev, spec, disputed);
      if (!r) { review.checkFailed = round; log(`[${condition}] Review round ${round}: the check itself failed; stopping this arm's loop (recorded, not a verdict on the change)`); break; }
      const pass = toPass(round, r);
      review.passes.push(pass);
      if (r.mergeable) { review.finalMergeable = true; log(`[${condition}] Review round ${round}: mergeable, stopping`); break; }
      if (!run.sessionId) { log(`[${condition}] Review: no session id to resume; stopping`); break; }
      if (run.killedReason) { log(`[${condition}] Review: the draft run was killed (${run.killedReason}); no fix pass`); break; }
      log(`[${condition}] Review round ${round}: fix pass, resuming session ${run.sessionId.slice(0, 8)}…`);
      const fixRun = await runClaude({
        prompt: (condition === "baseline" ? BASELINE_FIX_PREAMBLE : "") + fixPrompt(round, r),
        worktreePath: wtPath, model: config.model, condition, timeoutMs: remainingMs(), outDir,
        blockUnblocked: condition === "baseline", resumeSessionId: run.sessionId, priorTranscriptPath: run.jsonlPath, jsonlName: `${condition}.fix${round}.jsonl`,
      });
      spentMs += fixRun.durationMs;
      log(`[${condition}] Fix pass ${round} done: ${formatDuration(fixRun.durationMs)}, ${fixRun.assistantTurns} msgs, exit=${fixRun.exitCode}${fixRun.killedReason ? ` (killed: ${fixRun.killedReason})` : ""}`);
      fs.appendFileSync(run.jsonlPath, fs.readFileSync(fixRun.jsonlPath, "utf8"));
      disputed = disputedSection(fixRun.finalResponse);
      if (disputed) await adjudicateDisputes(config.task, spec, disputed, condition, round, config.checkerModel);
      pass.fix = { costUsd: fixRun.totalCostUsd ?? estimateCost(config.model, fixRun.tokenUsage), durationMs: fixRun.durationMs, messages: fixRun.assistantTurns, exitCode: fixRun.exitCode, timedOut: fixRun.timedOut, disputed };
      run = mergeRuns(run, fixRun, run.jsonlPath, config.model);
      ({ diff, stats: diffStats, agent } = captureDiff(wtPath, baseSha, refsBefore));
      log(`[${condition}] Diff after fix ${round}: ${formatDiffSummary(diffStats)}${disputed ? " (agent disputed part of the review)" : ""}`);
      if (fixRun.killedReason) break;
    }
    const last = review.passes[review.passes.length - 1];
    if (!review.finalMergeable && !review.checkFailed && last?.fix) {
      const armNow: ArmResult = { condition, run, diff, diffStats, unblockedCalls: [], estimatedCost: run.totalCostUsd ?? estimateCost(config.model, run.tokenUsage) };
      const r = await reviewDraft(config.task, armNow, config.checkerModel, last.round + 1, last, spec, disputed);
      if (r) { review.passes.push(toPass(last.round + 1, r)); review.finalMergeable = r.mergeable; }
      else review.checkFailed = last.round + 1;
    }
  }
  ctx.agentCommitsByArm.set(condition, agent);

  const unblockedCalls = extractUnblockedCalls(run.toolCalls);
  if (unblockedCalls.length > 0) {
    log(`[${condition}] Unblocked calls: ${unblockedCalls.length}`);
  }

  const cost = run.totalCostUsd ?? estimateCost(config.model, run.tokenUsage);

  return { condition, run, diff, diffStats, unblockedCalls, estimatedCost: cost, review };
}

const BASELINE_FIX_PREAMBLE = "IMPORTANT: as before, do NOT use any Unblocked tools, Unblocked skills, or Unblocked CLI commands.\n\n";

function mergeRuns(a: RunResult, b: RunResult, jsonlPath: string, model: string): RunResult {
  const addUsage = (x: TokenUsage, y: TokenUsage): TokenUsage => ({
    inputTokens: x.inputTokens + y.inputTokens, outputTokens: x.outputTokens + y.outputTokens,
    cacheCreationTokens: x.cacheCreationTokens + y.cacheCreationTokens, cacheReadTokens: x.cacheReadTokens + y.cacheReadTokens,
    ...(x.costUsd !== undefined || y.costUsd !== undefined ? { costUsd: (x.costUsd ?? 0) + (y.costUsd ?? 0) } : {}),
    ...(x.thinkingTokens !== undefined || y.thinkingTokens !== undefined ? { thinkingTokens: (x.thinkingTokens ?? 0) + (y.thinkingTokens ?? 0) } : {}),
  });
  const byModel: Record<string, TokenUsage> = { ...(a.tokenUsage.byModel ?? {}) };
  for (const [m, mu] of Object.entries(b.tokenUsage.byModel ?? {})) byModel[m] = byModel[m] ? addUsage(byModel[m], mu) : { ...mu };
  const costOf = (x: RunResult) => x.totalCostUsd ?? estimateCost(model, x.tokenUsage);
  const anyEstimated = !!(a.costEstimated || b.costEstimated || a.totalCostUsd === null || b.totalCostUsd === null);
  return {
    durationMs: a.durationMs + b.durationMs,
    wallMs: (a.wallMs ?? a.durationMs) + (b.wallMs ?? b.durationMs),
    tokenUsage: { ...addUsage(a.tokenUsage, b.tokenUsage), byModel },
    toolCalls: [...a.toolCalls, ...b.toolCalls],
    assistantTurns: a.assistantTurns + b.assistantTurns,
    finalResponse: b.finalResponse || a.finalResponse,
    sessionId: b.sessionId ?? a.sessionId,
    exitCode: b.exitCode ?? a.exitCode,
    timedOut: a.timedOut || b.timedOut,
    ...(b.killedReason ?? a.killedReason ? { killedReason: b.killedReason ?? a.killedReason } : {}),
    jsonlPath,
    worktreePath: a.worktreePath,
    totalCostUsd: costOf(a) + costOf(b),
    ...(anyEstimated ? { costEstimated: true } : {}),
  };
}

export async function run(config: Config, outDirOverride?: string, sharedSpec?: ReviewSpec): Promise<ComparisonResult> {
  const startTime = Date.now();
  const ctx: RunContext = { agentCommitsByArm: new Map(), worktreeByArm: new Map(), reviewSpec: null };

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomBytes(2).toString("hex");
  const outDir = outDirOverride ?? path.join(process.cwd(), "results", `run-${timestamp}`);
  const baselineDir = path.join(outDir, "baseline");
  const unblockedDir = path.join(outDir, "unblocked");
  fs.mkdirSync(baselineDir, { recursive: true });
  fs.mkdirSync(unblockedDir, { recursive: true });

  const refsBefore = snapshotRefs(config.repo);
  if (!refsBefore) throw new Error("Could not snapshot the repository's refs; without it the agent's commits cannot be told from existing history");
  warnIfBehindUpstream(config.repo, config.branch);
  keepMachineAwake();
  if (config.reviewRounds > 0) {
    ctx.reviewSpec = sharedSpec ? { ...sharedSpec, adjudications: [], costUsd: 0 } : await extractRequirements(config.task, config.checkerModel);
    if (!ctx.reviewSpec) throw new Error("Review: could not extract the task's requirements; not running the arms without a shared review standard");
  }
  const reviewSpec = ctx.reviewSpec;

  let baseline: ArmResult;
  let unblocked: ArmResult;

  try {
    [baseline, unblocked] = await Promise.all([
      runArm(config, "baseline", baselineDir, refsBefore, ctx),
      runArm(config, "unblocked", unblockedDir, refsBefore, ctx),
    ]);
  } finally {
    if (!config.keepWorktrees) {
      log("Cleaning up worktrees...");
      for (const [condition, name] of ctx.worktreeByArm) {
        removeWorktree(config.repo, name, refsBefore, ctx.agentCommitsByArm.get(condition) ?? new Set());
      }
    }
  }

  if (reviewSpec) {
    for (const arm of [baseline, unblocked]) applyWaivers(arm, reviewSpec);
    if (reviewSpec.adjudications.some(a => a.waived)) log(`Review: waived for both arms — ${reviewSpec.adjudications.filter(a => a.waived).map(a => `${a.index + 1}. ${reviewSpec!.requirements[a.index]} (disputed by ${a.disputedBy}, round ${a.round})`).join("; ")}`);
  }

  if (config.analystModel) {
    for (const arm of [baseline, unblocked]) {
      const a = await attribute(arm.run.jsonlPath, config.task, arm.run.totalCostUsd ?? arm.estimatedCost, config.analystModel, arm.condition);
      if (a) arm.attribution = a;
    }
  }

  const result: ComparisonResult = {
    repo: config.repo,
    task: config.task,
    branch: config.branch,
    model: config.model,
    baseline,
    unblocked,
    totalDurationMs: Math.max(baseline.run.durationMs, unblocked.run.durationMs),
    totalEstimatedCost: baseline.estimatedCost + unblocked.estimatedCost,
    ...(reviewSpec ? { reviewSpec } : {}),
  };
  const killed = [baseline, unblocked].filter(a => a.run.killedReason);
  if (killed.length) log(`⚠ ${killed.map(a => `${a.condition} was killed (${a.run.killedReason})`).join("; ")}: no quality or impact verdict for an unfinished comparison`);
  if (config.analystModel && !killed.length) {
    const q = await assessQuality(result, config.judgeModel);
    if (q) result.quality = q;
    result.economics = economics(result);
    if (q) { const im = await assessImpact(result, config.judgeModel); if (im) result.impact = im; }
    else log("Impact: skipped, no quality verdict to assess against");
    applyTieBreaker(result);
    if (result.quality?.verdict.tieBreaker?.applied) log(`Verdict: blinded tie → Unblocked by the tie-breaker (${result.quality.verdict.tieBreaker.reason})`);
  } else if (config.analystModel) {
    result.economics = economics(result);
  }
  const reviewCost = (a: ArmResult) => (a.review?.passes ?? []).reduce((s, p) => s + p.reviewCostUsd, 0);
  result.analysisCostUsd = (baseline.attribution?.analystCostUsd ?? 0) + (unblocked.attribution?.analystCostUsd ?? 0) + (result.quality?.judgeCostUsd ?? 0) + (result.impact?.costUsd ?? 0) + reviewCost(baseline) + reviewCost(unblocked) + (reviewSpec?.costUsd ?? 0);
  log(`Experiment wall time ${formatDuration(Date.now() - startTime)} incl. analysis`);

  printReport(result);
  writeJsonResult(result, outDir);
  const htmlPath = writeHtmlReport(result, outDir);

  log(`Results: ${outDir}`);
  log(`HTML report: ${htmlPath}`);
  log(`Total time: ${formatDuration(result.totalDurationMs)}`);
  log(`Total cost: ${formatCost(result.totalEstimatedCost)}`);

  if (!outDirOverride) {
    try {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      execSync(`${opener} "${htmlPath}"`);
    } catch {}
  }

  return result;
}

export async function runBatch(config: Config): Promise<{ batchDir: string; results: ComparisonResult[] }> {
  if (config.repeat <= 1) {
    const r = await run(config);
    return { batchDir: path.dirname(r.baseline.run.jsonlPath.replace(/\/baseline\/[^/]+$/, "")), results: [r] };
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomBytes(2).toString("hex");
  const batchDir = path.join(process.cwd(), "results", `batch-${timestamp}`);
  fs.mkdirSync(batchDir, { recursive: true });
  log(`Batch: ${config.repeat} repeats, ${config.concurrency} at a time → ${batchDir}`);
  let sharedSpec: ReviewSpec | undefined;
  if (config.reviewRounds > 0) {
    const spec = await extractRequirements(config.task, config.checkerModel);
    if (!spec) throw new Error("Review: could not extract the task's requirements; not running the batch without a shared review standard");
    sharedSpec = spec;
    fs.writeFileSync(path.join(batchDir, "requirements.json"), JSON.stringify(spec, null, 2));
  }
  const results: (ComparisonResult | null)[] = new Array(config.repeat).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < config.repeat) {
      const i = next++;
      const dir = path.join(batchDir, `run-${i + 1}`);
      try {
        results[i] = await run(config, dir, sharedSpec);
        log(`Batch: run ${i + 1}/${config.repeat} done`);
      } catch (err) {
        log(`Batch: run ${i + 1}/${config.repeat} failed: ${(err as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(config.concurrency, config.repeat)) }, worker));
  const done = results.filter((r): r is ComparisonResult => r !== null);
  const htmlPath = writeBatchSummary(config, done, batchDir);
  log(`Batch summary: ${htmlPath}`);
  try {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    execSync(`${opener} "${htmlPath}"`);
  } catch {}
  return { batchDir, results: done };
}
