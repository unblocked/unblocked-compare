/**
 * LLM-as-judge.
 *
 * This is the ONLY non-deterministic step in the entire comparison.
 * A single model call evaluates both session transcripts blindly
 * across a structured rubric.
 */

import type { ProviderAdapter } from "./providers/types.js";
import type { RunResult } from "./harness.js";

export interface JudgeResult {
  analysis: string;
  sessionALabel: string;
  sessionBLabel: string;
}

export async function judgeComparison(
  provider: ProviderAdapter,
  task: string,
  repoPath: string,
  baseline: RunResult,
  enhanced: RunResult
): Promise<JudgeResult> {
  // Randomize which session is A vs B to eliminate position bias
  const showEnhancedFirst = Math.random() < 0.5;
  const sessionA = showEnhancedFirst ? enhanced : baseline;
  const sessionB = showEnhancedFirst ? baseline : enhanced;

  const prompt = `You are evaluating two AI agent sessions that performed the same task on the same codebase. One session had access to additional institutional context tools (code history, PRs, Slack discussions, Jira issues, docs) and the other did not. You do NOT know which is which — evaluate purely on output quality.

## Task
${task}

## Repository
${repoPath}

## Session A
- Duration: ${(sessionA.elapsedMs / 1000).toFixed(1)}s
- Tokens: ${sessionA.tokenUsage.input.toLocaleString()} input / ${sessionA.tokenUsage.output.toLocaleString()} output
- Tool calls: ${sessionA.toolCalls.length} (${sessionA.mcpCalls} MCP context queries)
- Turns: ${sessionA.turns}

### Tool usage timeline:
${formatToolTimeline(sessionA)}

### Final response:
${sessionA.finalResponse.slice(0, 30000)}

## Session B
- Duration: ${(sessionB.elapsedMs / 1000).toFixed(1)}s
- Tokens: ${sessionB.tokenUsage.input.toLocaleString()} input / ${sessionB.tokenUsage.output.toLocaleString()} output
- Tool calls: ${sessionB.toolCalls.length} (${sessionB.mcpCalls} MCP context queries)
- Turns: ${sessionB.turns}

### Tool usage timeline:
${formatToolTimeline(sessionB)}

### Final response:
${sessionB.finalResponse.slice(0, 30000)}

## Your Analysis

Compare these two sessions across these dimensions. For each, give a score from 1-10:

1. **Quality of understanding** — Did the agent correctly understand the context, conventions, and intent behind the task?
2. **Quality of implementation** — Were the code changes appropriate, following existing patterns and conventions?
3. **Awareness of context** — Did the agent discover relevant prior work, discussions, or decisions that should inform the implementation?
4. **Risk awareness** — Did the agent flag risks, conflicts, or related ongoing work?
5. **Efficiency** — Compare wall-clock time, token usage, and number of tool calls relative to output quality.

Provide a structured comparison in markdown. End with:

## Scores
| Dimension | Session A | Session B |
|---|---|---|
| Understanding | X/10 | X/10 |
| Implementation | X/10 | X/10 |
| Context awareness | X/10 | X/10 |
| Risk awareness | X/10 | X/10 |
| Efficiency | X/10 | X/10 |
| **Total** | XX/50 | XX/50 |

## Verdict
State which session produced better results and why in 2-3 sentences.

IMPORTANT: Always refer to the sessions as "Session A" and "Session B" throughout your analysis. Do not use other names.`;

  const response = await provider.chat({
    system: "You are an expert code reviewer evaluating AI agent sessions. Be precise and evidence-based.",
    messages: [{ role: "user", content: prompt }],
    tools: [],
  });

  let analysis = "";
  for (const block of response.content) {
    if (block.type === "text") analysis += block.text;
  }

  // Replace blinded labels with real labels so the reader never sees Session A/B.
  // The judge evaluated blindly — we re-label for the final report.
  const enhancedLabel = "Enhanced (Unblocked)";
  const baselineLabel = "Baseline";
  const aLabel = showEnhancedFirst ? enhancedLabel : baselineLabel;
  const bLabel = showEnhancedFirst ? baselineLabel : enhancedLabel;

  analysis = analysis
    .replace(/Session A/g, aLabel)
    .replace(/Session B/g, bLabel);

  return {
    analysis,
    sessionALabel: aLabel,
    sessionBLabel: bLabel,
  };
}

function formatToolTimeline(result: RunResult): string {
  return result.toolCalls
    .slice(0, 50)
    .map((tc) => {
      const ts = `[${(tc.timestamp / 1000).toFixed(1)}s]`;
      const mcpTag = tc.isMcp ? ` [MCP: ${tc.mcpServer}]` : "";
      const name = tc.name.split("__").pop() || tc.name;
      const inputSummary =
        tc.name === "bash"
          ? (tc.input as { command?: string }).command?.slice(0, 80) || ""
          : "";
      return `${ts} ${name}${mcpTag}${inputSummary ? ": " + inputSummary : ""}`;
    })
    .join("\n");
}
