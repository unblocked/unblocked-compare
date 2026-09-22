import type { Condition, RunResult } from "../types.ts";

export type AgentName = "claude" | "cursor" | "codex";

export interface AgentRunOpts {
  prompt: string;
  worktreePath: string;
  model?: string;
  condition: Condition;
  timeoutMs: number;
  outDir: string;
  // Baseline arm: the agent must not see Unblocked. CLI mode: neither arm gets
  // the Unblocked MCP server; the Unblocked arm uses the `unblocked` CLI.
  blockUnblocked: boolean;
  cliMode: boolean;
  resumeSessionId?: string;
  priorTranscriptPath?: string;
  jsonlName?: string;
}

export interface Agent {
  name: AgentName;
  // Display name for logs and reports.
  label: string;
  // Model used when --model is not given. Undefined means the agent CLI's own
  // configured default, which the adapter reports in RunResult.model.
  defaultModel?: string;
  // Set when the agent cannot reach the Unblocked MCP server headlessly: the
  // reason, logged when the harness switches the comparison to the CLI.
  cliOnly?: string;
  // Per-arm setup in the fresh worktree, before the first run.
  prepareWorktree(wtPath: string, condition: Condition, cliMode: boolean): void;
  run(opts: AgentRunOpts): Promise<RunResult>;
}
