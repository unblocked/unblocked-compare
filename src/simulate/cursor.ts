import { spawn } from "node:child_process";
import type { AgentInvokeOptions, AgentResult } from "./types.ts";
import { ContaminationError } from "./types.ts";
import { createStreamState, processStreamChunk } from "./stream.ts";
import { ToolRecorder } from "./tools.ts";
import { estimateCost } from "./util.ts";

interface CursorRawOutput {
  type: "result";
  subtype: string;
  is_error: boolean;
  duration_ms: number;
  duration_api_ms: number;
  result: string;
  session_id: string;
  request_id: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
}

function parseCursorOutput(raw: CursorRawOutput, model: string, numTurns?: number): AgentResult {
  const tokens = {
    inputTokens: raw.usage.inputTokens,
    outputTokens: raw.usage.outputTokens,
    cacheReadTokens: raw.usage.cacheReadTokens,
    cacheCreationTokens: raw.usage.cacheWriteTokens,
  };
  return {
    success: !raw.is_error,
    result: raw.result ?? "",
    durationMs: raw.duration_ms,
    costUsd: estimateCost(model, tokens),
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    cacheReadTokens: tokens.cacheReadTokens,
    cacheCreationTokens: tokens.cacheCreationTokens,
    numTurns: numTurns ?? 1,
    sessionId: raw.session_id,
  };
}

function failedResult(error: string): AgentResult {
  return {
    success: false,
    result: "",
    durationMs: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    numTurns: 0,
    sessionId: "",
    error,
  };
}

export function invokeCursor(opts: AgentInvokeOptions): Promise<AgentResult> {
  // Always stream: the tool recorder and the contamination check read the
  // events. --verbose only decides whether agent activity is logged.
  const streaming = opts.verbose ?? false;
  const args: string[] = [
    "-p",
    "--output-format", "stream-json",
    "--trust",
    "--approve-mcps",
    "--workspace", opts.cwd,
    "--model", opts.model,
  ];

  if (opts.worktree) {
    args.push("--worktree", opts.worktree);
    if (opts.worktreeBase) {
      args.push("--worktree-base", opts.worktreeBase);
    }
  }

  if (opts.dangerouslySkipPermissions) {
    args.push("--yolo");
  }

  if (opts.tools === "") {
    args.push("--mode", "ask");
  }

  const systemText = [opts.systemPrompt, opts.appendSystemPrompt]
    .filter(Boolean)
    .join("\n\n");
  const fullPrompt = systemText
    ? `${systemText}\n\n---\n\n${opts.prompt}`
    : opts.prompt;

  args.push(fullPrompt);

  return new Promise((resolve, reject) => {
    const child = spawn("agent", args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
    });

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, opts.timeoutMs);

    const tag = opts.tag ?? "cursor";
    const state = createStreamState();
    const recorder = new ToolRecorder("cursor");
    let finalResult: CursorRawOutput | null = null;
    let contaminated = false;
    const onResult = (e: Record<string, unknown>) => { finalResult = e as unknown as CursorRawOutput; };
    const onLine = (line: string) => recorder.feed(line);

    child.stdout.on("data", (chunk: Buffer) => {
      if (contaminated) return;
      processStreamChunk(chunk.toString(), tag, state, {
        onResult,
        onLine,
        quiet: !streaming,
        bannedMcpServers: opts.bannedMcpServers,
        onContamination: (server, detail) => {
          if (contaminated) return;
          contaminated = true;
          child.kill("SIGTERM");
          clearTimeout(timer);
          reject(new ContaminationError(server, detail));
        },
      });
    });

    child.stderr.on("data", (d: Buffer) => {
      if (streaming) process.stderr.write(`[${tag}:stderr] ${d}`);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (contaminated) return;
      // Flush any trailing line not terminated by a newline (the result event
      // can arrive without a final \n before the stream closes).
      if (state.partial) {
        processStreamChunk(state.partial + "\n", tag, state, { onResult, onLine, quiet: !streaming });
      }
      if (finalResult) {
        resolve({ ...parseCursorOutput(finalResult, opts.model, state.turnCount), toolCalls: recorder.calls() });
      } else {
        resolve(failedResult(`No result event in cursor stream. Exit code: ${code}`));
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve(failedResult(`Failed to spawn agent: ${err.message}`));
    });
  });
}
