/**
 * Report generation.
 *
 * Produces structured markdown reports from comparison results.
 * All data is computed procedurally — no LLM involvement except
 * the judge analysis which is passed through as-is.
 */

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import type { RunResult } from "./harness.js";
import type { JudgeResult } from "./judge.js";
import { calculateCost, formatCost, type CostBreakdown } from "./costs.js";

// ── Token redaction ────────────────────────────────────────────────────
const TOKEN_PATTERN =
  /\b(ghp_|gho_|ghs_|ghu_|github_pat_|sk-ant-|sk-|xoxp-|xoxb-|ubk_)\S+/g;

function redact(text: string): string {
  return text.replace(TOKEN_PATTERN, "REDACTED");
}

// ── Individual session transcript ──────────────────────────────────────

function writeSessionTranscript(
  dir: string,
  result: RunResult,
  model: string,
  task: string,
  repoPath: string
): string {
  const cost = calculateCost(model, result.tokenUsage.input, result.tokenUsage.output);

  const lines: string[] = [
    `# Session Transcript: ${result.label}`,
    ``,
    `**Task:** ${task}`,
    `**Repo:** ${repoPath}`,
    `**Model:** ${model}`,
    `**Duration:** ${(result.elapsedMs / 1000).toFixed(1)}s`,
    `**Tokens:** ${result.tokenUsage.input.toLocaleString()} input, ${result.tokenUsage.output.toLocaleString()} output`,
    `**Estimated cost:** ${formatCost(cost)}`,
    `**Tool calls:** ${result.toolCalls.length} (${result.mcpCalls} MCP)`,
    `**Turns:** ${result.turns}`,
    ``,
    `---`,
    ``,
    `## Tool Call Log`,
    ``,
  ];

  for (const tc of result.toolCalls) {
    const ts = `[${(tc.timestamp / 1000).toFixed(1)}s]`;
    const name = tc.name.split("__").pop() || tc.name;
    const mcpTag = tc.isMcp ? ` **[MCP: ${tc.mcpServer}]**` : "";
    const duration = `(${tc.durationMs}ms)`;
    const errorTag = tc.isError ? " **[ERROR]**" : "";

    lines.push(`${ts} **${name}**${mcpTag}${errorTag} ${duration}`);

    // Show input summary
    if (tc.name === "bash") {
      const cmd = (tc.input as { command?: string }).command || "";
      lines.push(`  \`$ ${redact(cmd.slice(0, 200))}\``);
    }
  }

  lines.push(
    "",
    "---",
    "",
    "## Model Call Details",
    "",
    "| Call | Input Tokens | Output Tokens | Duration |",
    "|---|---|---|---|"
  );

  for (let i = 0; i < result.modelCalls.length; i++) {
    const mc = result.modelCalls[i];
    lines.push(
      `| ${i + 1} | ${mc.inputTokens.toLocaleString()} | ${mc.outputTokens.toLocaleString()} | ${(mc.durationMs / 1000).toFixed(1)}s |`
    );
  }

  lines.push(
    "",
    "---",
    "",
    "## Full Response",
    "",
    redact(result.finalResponse)
  );

  const filename = `${result.label}.md`;
  writeFileSync(join(dir, filename), lines.join("\n"));
  return filename;
}

// ── Comparison report ──────────────────────────────────────────────────

export function writeComparisonReport(params: {
  outputDir: string;
  task: string;
  repoPath: string;
  model: string;
  baseline: RunResult;
  enhanced: RunResult;
  judgeResult: JudgeResult;
}): { comparisonFile: string; baselineFile: string; enhancedFile: string } {
  const { outputDir, task, repoPath, model, baseline, enhanced, judgeResult } =
    params;

  mkdirSync(outputDir, { recursive: true });

  // Write individual transcripts
  const baselineFile = writeSessionTranscript(
    outputDir,
    baseline,
    model,
    task,
    repoPath
  );
  const enhancedFile = writeSessionTranscript(
    outputDir,
    enhanced,
    model,
    task,
    repoPath
  );

  // Compute costs
  const baselineCost = calculateCost(
    model,
    baseline.tokenUsage.input,
    baseline.tokenUsage.output
  );
  const enhancedCost = calculateCost(
    model,
    enhanced.tokenUsage.input,
    enhanced.tokenUsage.output
  );

  // Token totals for the table
  const totalTokensBaseline =
    baseline.tokenUsage.input + baseline.tokenUsage.output;
  const totalTokensEnhanced =
    enhanced.tokenUsage.input + enhanced.tokenUsage.output;

  const comparisonContent = [
    `# A/B Comparison Report`,
    ``,
    `**Task:** ${task}`,
    `**Repo:** ${repoPath}`,
    `**Model:** ${model}`,
    `**Date:** ${new Date().toISOString().split("T")[0]}`,
    `**Time:** ${new Date().toISOString().split("T")[1].slice(0, 8)}`,
    ``,
    `## Configuration`,
    ``,
    `- **Baseline MCPs:** ${
      baseline.toolCalls.filter((tc) => tc.isMcp).length > 0
        ? [...new Set(baseline.toolCalls.filter((tc) => tc.isMcp).map((tc) => tc.mcpServer))].join(", ")
        : "none"
    }`,
    `- **Enhanced MCPs:** ${
      [...new Set(enhanced.toolCalls.filter((tc) => tc.isMcp).map((tc) => tc.mcpServer))].join(", ") || "Unblocked"
    }`,
    ``,
    `## Metrics Summary`,
    ``,
    `| Metric | Baseline | Enhanced (Unblocked) | Delta |`,
    `|---|---|---|---|`,
    `| Duration | ${(baseline.elapsedMs / 1000).toFixed(0)}s | ${(enhanced.elapsedMs / 1000).toFixed(0)}s | ${humanDeltaDuration(baseline.elapsedMs, enhanced.elapsedMs)} |`,
    `| Input tokens | ${baseline.tokenUsage.input.toLocaleString()} | ${enhanced.tokenUsage.input.toLocaleString()} | ${humanDelta(baseline.tokenUsage.input, enhanced.tokenUsage.input, "input tokens")} |`,
    `| Output tokens | ${baseline.tokenUsage.output.toLocaleString()} | ${enhanced.tokenUsage.output.toLocaleString()} | ${humanDelta(baseline.tokenUsage.output, enhanced.tokenUsage.output, "output tokens")} |`,
    `| Total tokens | ${totalTokensBaseline.toLocaleString()} | ${totalTokensEnhanced.toLocaleString()} | ${humanDelta(totalTokensBaseline, totalTokensEnhanced, "token use")} |`,
    `| Estimated cost | ${formatCost(baselineCost)} | ${formatCost(enhancedCost)} | ${formatCostDelta(baselineCost, enhancedCost)} |`,
    `| Tool calls | ${baseline.toolCalls.length} | ${enhanced.toolCalls.length} | ${humanDelta(baseline.toolCalls.length, enhanced.toolCalls.length, "tool calls")} |`,
    `| MCP queries | ${baseline.mcpCalls} | ${enhanced.mcpCalls} | ${enhanced.mcpCalls - baseline.mcpCalls > 0 ? `+${enhanced.mcpCalls - baseline.mcpCalls}` : "0"} |`,
    `| Turns | ${baseline.turns} | ${enhanced.turns} | ${humanDelta(baseline.turns, enhanced.turns, "turns")} |`,
    ``,
    `## Judge Analysis`,
    ``,
    `> **Methodology:** The judge is a single LLM call that evaluates both sessions blindly. ` +
      `During evaluation, sessions are labeled "Session A" and "Session B" in randomized order — ` +
      `the judge does not know which session used Unblocked. Labels in the analysis below have ` +
      `been replaced with "Baseline" and "Enhanced (Unblocked)" after the fact for readability.`,
    ``,
    judgeResult.analysis,
    ``,
    `---`,
    ``,
    `*Generated by unblocked-compare v0.1.0*`,
  ].join("\n");

  const comparisonFile = "comparison.md";
  writeFileSync(join(outputDir, comparisonFile), comparisonContent);

  // Also write a JSON report for programmatic consumption
  const jsonReport = {
    task,
    repo: repoPath,
    model,
    date: new Date().toISOString(),
    baseline: {
      elapsedMs: baseline.elapsedMs,
      turns: baseline.turns,
      tokenUsage: baseline.tokenUsage,
      cost: baselineCost,
      toolCalls: baseline.toolCalls.length,
      mcpCalls: baseline.mcpCalls,
    },
    enhanced: {
      elapsedMs: enhanced.elapsedMs,
      turns: enhanced.turns,
      tokenUsage: enhanced.tokenUsage,
      cost: enhancedCost,
      toolCalls: enhanced.toolCalls.length,
      mcpCalls: enhanced.mcpCalls,
    },
    deltas: {
      timeMs: enhanced.elapsedMs - baseline.elapsedMs,
      timePct: baseline.elapsedMs > 0
        ? (enhanced.elapsedMs - baseline.elapsedMs) / baseline.elapsedMs * 100
        : 0,
      tokenDelta: totalTokensEnhanced - totalTokensBaseline,
      tokenPct: totalTokensBaseline > 0
        ? (totalTokensEnhanced - totalTokensBaseline) / totalTokensBaseline * 100
        : 0,
      costDelta: enhancedCost.totalCost - baselineCost.totalCost,
    },
  };

  writeFileSync(
    join(outputDir, "comparison.json"),
    JSON.stringify(jsonReport, null, 2)
  );

  return { comparisonFile, baselineFile, enhancedFile };
}

/**
 * Format a delta as human-readable "X% less/more <unit>" text.
 * enhancedVal and baselineVal are the raw numbers; unit is the label.
 */
function humanDelta(
  baselineVal: number,
  enhancedVal: number,
  unit: string
): string {
  if (baselineVal === 0) return "N/A";
  const delta = enhancedVal - baselineVal;
  if (delta === 0) return `no change`;
  const absDelta = Math.abs(delta);
  const absPct = Math.abs((delta / baselineVal) * 100).toFixed(1);
  const direction = delta < 0 ? "less" : "more";
  return `${absDelta.toLocaleString()} ${direction} (${absPct}% ${direction} ${unit})`;
}

function humanDeltaDuration(baselineMs: number, enhancedMs: number): string {
  if (baselineMs === 0) return "N/A";
  const deltaMs = enhancedMs - baselineMs;
  if (deltaMs === 0) return "no change";
  const absSec = Math.abs(deltaMs / 1000).toFixed(0);
  const absPct = Math.abs((deltaMs / baselineMs) * 100).toFixed(1);
  const direction = deltaMs < 0 ? "faster" : "slower";
  return `${absSec}s ${direction} (${absPct}% ${direction})`;
}

function formatCostDelta(a: CostBreakdown, b: CostBreakdown): string {
  if (!a.pricingFound || !b.pricingFound) return "N/A";
  const delta = b.totalCost - a.totalCost;
  if (a.totalCost === 0) return `$${delta.toFixed(4)}`;
  const absPct = Math.abs((delta / a.totalCost) * 100).toFixed(1);
  if (delta < 0) {
    return `$${Math.abs(delta).toFixed(4)} less (${absPct}% savings)`;
  } else if (delta > 0) {
    return `$${delta.toFixed(4)} more (${absPct}% increase)`;
  }
  return "no change";
}
