// Generate a comparison report from two existing stream-json transcripts.
// Token usage and tool calls are always re-parsed from the transcripts. The
// task prompt, branch, and code diffs are not recorded in stream-json output:
// pass the run's original result.json (third argument, detected by .json
// extension) to carry them over, or supply model/branch/task as arguments.
// Repo and model fall back to the transcript's init event.
import fs from "node:fs";
import path from "node:path";
import { parseStreamJson, type SessionCumulative } from "../src/claude.ts";
import { printReport, writeHtmlReport, writeJsonResult } from "../src/report.ts";
import { estimateCost } from "../src/util.ts";
import { attribute, buildWalk, rollup } from "../src/attribution.ts";
import { applyTieBreaker, assessQuality } from "../src/quality.ts";
import { assessImpact } from "../src/impact.ts";
import { economics } from "../src/economics.ts";
import { extractUnblockedCalls } from "../src/runner.ts";
import type { ArmResult, ComparisonResult, Condition, UnblockedCall } from "../src/types.ts";

interface InitInfo { cwd?: string; model?: string }

function initInfo(jsonl: string): InitInfo {
  for (const line of jsonl.split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e?.type === "system" && e?.subtype === "init" && (e.cwd || e.model)) {
        return { cwd: e.cwd, model: e.model };
      }
    } catch {}
  }
  return {};
}

// Worktrees live at <wt-root>/<repo>/<arm>-<hash>, so the repo name is the
// parent directory of the run cwd. Handles both / and \ separators.
function repoFromCwd(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  return parts.length >= 2 ? parts[parts.length - 2] : undefined;
}

function durationMs(jsonl: string): number {
  let first = NaN, last = NaN, total = 0, seen = false;
  for (const line of jsonl.split("\n")) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e?.type === "result" && typeof e.duration_ms === "number") { total += e.duration_ms; seen = true; }
      if (typeof e?.timestamp === "string") { const t = Date.parse(e.timestamp); if (Number.isNaN(first)) first = t; last = t; }
    } catch {}
  }
  return seen ? total : (Number.isNaN(first) ? 0 : Math.max(0, last - first));
}

function arm(condition: Condition, file: string, model: string, orig?: ArmResult): ArmResult {
  const jsonl = fs.readFileSync(file, "utf8");
  const parsed = parseStreamJson(jsonl);
  const run = {
    durationMs: durationMs(jsonl),
    tokenUsage: parsed.tokenUsage,
    toolCalls: parsed.toolCalls,
    assistantTurns: parsed.assistantTurns,
    finalResponse: parsed.finalResponse,
    sessionId: parsed.sessionId,
    exitCode: orig?.run.exitCode ?? 0,
    timedOut: orig?.run.timedOut ?? false,
    ...(orig?.run.killedReason ?? parsed.apiError ? { killedReason: orig?.run.killedReason ?? `the CLI stopped on an ${parsed.apiError}` } : {}),
    jsonlPath: file,
    worktreePath: orig?.run.worktreePath ?? "(from transcript)",
    totalCostUsd: parsed.totalCostUsd,
    ...(parsed.totalCostUsd === null ? { costEstimated: true } : {}),
  };
  const cost = run.totalCostUsd ?? estimateCost(model, run.tokenUsage);
  return {
    condition, run,
    diff: orig?.diff ?? "(not captured — generated from transcript)",
    diffStats: orig?.diffStats ?? { filesChanged: 0, linesAdded: 0, linesRemoved: 0, commits: 0 },
    unblockedCalls: extractUnblockedCalls(parsed.toolCalls),
    estimatedCost: cost,
    attribution: orig?.attribution,
    review: orig?.review ? reparseReview(orig.review, file, model) : undefined,
  };
}

function reparseReview(review: NonNullable<ArmResult["review"]>, jsonlPath: string, model: string) {
  const dir = path.dirname(jsonlPath), stem = path.basename(jsonlPath, ".jsonl");
  let prior: SessionCumulative | null = null;
  const price = (file: string) => {
    if (!fs.existsSync(file)) return null;
    const jsonl = fs.readFileSync(file, "utf8");
    const p = parseStreamJson(jsonl, prior, true);
    prior = p.sessionCumulative;
    return { costUsd: p.totalCostUsd ?? estimateCost(model, p.tokenUsage), durationMs: durationMs(jsonl), messages: p.assistantTurns };
  };
  const draft = price(path.join(dir, `${stem}.draft.jsonl`));
  if (!draft) return review;
  return {
    ...review,
    draft: { ...review.draft, ...draft },
    passes: review.passes.map(pass => {
      if (!pass.fix) return pass;
      const fix = price(path.join(dir, `${stem}.fix${pass.round}.jsonl`)) ?? price(path.join(dir, `${stem}.fix.jsonl`));
      return fix ? { ...pass, fix: { ...pass.fix, ...fix } } : pass;
    }),
  };
}

const KNOWN = /^--(attribute|rejudge|impact)(=.*)?$/;
const flagModel = (name: string, dflt: string) => { const f = process.argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`)); return f ? (f.split("=")[1] || dflt) : null; };
const attrModel = flagModel("attribute", "opus");
const judgeModel = flagModel("rejudge", "fable");
const impactModel = flagModel("impact", "fable");
const [,, baseFile, ubFile, thirdArg, branchArg, ...taskArg] = process.argv.filter(a => !KNOWN.test(a));
const orig: ComparisonResult | undefined = thirdArg?.endsWith(".json")
  ? JSON.parse(fs.readFileSync(thirdArg, "utf8"))
  : undefined;
const modelArg = orig ? undefined : thirdArg;
const init = initInfo(fs.readFileSync(baseFile, "utf8"));
const model = orig?.model ?? modelArg ?? init.model ?? "claude-opus-4-8";
const branch = orig?.branch ?? branchArg ?? "(not recorded in transcripts)";
const task = orig?.task ?? (taskArg.join(" ") || "(task not recorded in transcripts)");
const repo = orig?.repo ?? repoFromCwd(init.cwd) ?? "(from transcripts)";
const baseline = arm("baseline", baseFile, model, orig?.baseline);
const unblocked = arm("unblocked", ubFile, model, orig?.unblocked);
for (const a of [baseline, unblocked]) {
  if (attrModel) {
    const attr = await attribute(a.run.jsonlPath, task, a.run.totalCostUsd ?? a.estimatedCost, attrModel, a.condition);
    if (attr) a.attribution = attr;
  } else if (a.attribution) {
    const walk = buildWalk(fs.readFileSync(a.run.jsonlPath, "utf8"), a.run.totalCostUsd ?? a.estimatedCost);
    const labels = a.attribution.turns.map(t => ({ turn: t.turn, label: t.label, repeatOf: t.repeatOf, reason: t.reason }));
    if (walk.length === a.attribution.turns.length) a.attribution = rollup(walk, labels, a.attribution.analystModel, a.attribution.analystCostUsd);
    else console.error(`[${a.condition}] transcript has ${walk.length} messages, stored attribution ${a.attribution.turns.length}; keeping stored numbers`);
  }
}

const result: ComparisonResult = {
  repo,
  task,
  branch,
  model,
  baseline,
  unblocked,
  totalDurationMs: Math.max(baseline.run.durationMs, unblocked.run.durationMs),
  totalEstimatedCost: baseline.estimatedCost + unblocked.estimatedCost,
  ...(orig?.reviewSpec ? { reviewSpec: orig.reviewSpec } : {}),
};

const killed = [baseline, unblocked].filter(a => a.run.killedReason);
if (killed.length) console.error(`⚠ ${killed.map(a => `${a.condition} was killed (${a.run.killedReason})`).join("; ")}: judge and impact are not re-run for an unfinished comparison`);
if (judgeModel && !killed.length) result.quality = (await assessQuality(result, judgeModel)) ?? orig?.quality;
else if (orig?.quality) result.quality = orig.quality;

result.economics = economics(result);
if (impactModel && !killed.length && result.quality) result.impact = (await assessImpact(result, impactModel)) ?? orig?.impact;
else if (orig?.impact) result.impact = orig.impact;

applyTieBreaker(result);

const reviewCost = (a: ArmResult) => (a.review?.passes ?? []).reduce((s, p) => s + p.reviewCostUsd, 0);
result.analysisCostUsd = (baseline.attribution?.analystCostUsd ?? 0) + (unblocked.attribution?.analystCostUsd ?? 0) + (result.quality?.judgeCostUsd ?? 0) + (result.impact?.costUsd ?? 0) + reviewCost(baseline) + reviewCost(unblocked) + (result.reviewSpec?.costUsd ?? 0);

const outDir = path.join(process.cwd(), "results", "regenerated");
fs.mkdirSync(outDir, { recursive: true });
printReport(result);
writeJsonResult(result, outDir);
const htmlPath = writeHtmlReport(result, outDir);
console.log("HTML:", htmlPath);
