import { spawn } from "node:child_process";
import type { AgentInvokeOptions, ClaudeRawOutput, AgentResult } from "./types.ts";
import { ContaminationError } from "./types.ts";
import { createStreamState, processStreamChunk } from "./stream.ts";
import { ToolRecorder } from "./tools.ts";

function parseClaudeOutput(raw: ClaudeRawOutput): AgentResult {
  return {
    success: !raw.is_error,
    result: raw.result ?? "",
    durationMs: raw.duration_ms,
    costUsd: raw.total_cost_usd,
    inputTokens: raw.usage.input_tokens,
    outputTokens: raw.usage.output_tokens,
    cacheReadTokens: raw.usage.cache_read_input_tokens,
    cacheCreationTokens: raw.usage.cache_creation_input_tokens,
    numTurns: raw.num_turns,
    sessionId: raw.session_id,
    structuredOutput: raw.structured_output,
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

export function invokeClaude(opts: AgentInvokeOptions): Promise<AgentResult> {
  // Always stream: the tool recorder and the contamination check read the
  // events. --verbose only decides whether agent activity is logged.
  const streaming = opts.verbose ?? false;
  const args: string[] = ["-p", "--output-format", "stream-json", "--verbose", "--model", opts.model];

  if (opts.worktree) {
    args.push("--worktree", opts.worktree);
  }

  if (opts.dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  }

  if (opts.systemPrompt) {
    args.push("--system-prompt", opts.systemPrompt);
  }

  if (opts.appendSystemPrompt) {
    args.push("--append-system-prompt", opts.appendSystemPrompt);
  }

  if (opts.disallowedTools?.length) {
    args.push("--disallowed-tools", ...opts.disallowedTools);
  }

  if (opts.allowedTools?.length) {
    args.push("--allowed-tools", ...opts.allowedTools);
  }

  if (opts.tools !== undefined) {
    args.push("--tools", opts.tools);
  }

  if (opts.jsonSchema) {
    args.push("--json-schema", opts.jsonSchema);
  }

  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...opts.env },
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // Escalate to SIGKILL if the agent ignores SIGTERM (e.g. it spawned subprocesses).
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, opts.timeoutMs);

    // Guard against EPIPE if the child exits before consuming stdin; the close/error
    // handlers report the failure, so this just prevents an unhandled throw.
    child.stdin.on("error", () => { /* ignore broken-pipe writes */ });
    child.stdin.write(opts.prompt);
    child.stdin.end();

    const tag = opts.tag ?? "claude";
    const state = createStreamState();
    const recorder = new ToolRecorder("claude");
    let finalResult: ClaudeRawOutput | null = null;
    let contaminated = false;
    const onResult = (e: Record<string, unknown>) => { finalResult = e as unknown as ClaudeRawOutput; };
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
      if (state.partial) {
        processStreamChunk(state.partial + "\n", tag, state, { onResult, onLine, quiet: !streaming });
      }
      if (finalResult) {
        resolve({ ...parseClaudeOutput(finalResult), toolCalls: recorder.calls() });
      } else {
        resolve(failedResult(
          timedOut
            ? `Timed out after ${opts.timeoutMs}ms before emitting a result.`
            : `No result event in stream. Exit code: ${code}`,
        ));
      }
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve(failedResult(`Failed to spawn claude: ${err.message}`));
    });
  });
}
