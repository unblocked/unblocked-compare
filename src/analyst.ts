import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { log } from "./util.ts";

const BINARY = process.env.CLAUDE_BINARY ?? "claude";
export const FALLBACK_MODEL = "opus";

export const VERIFY_CMD = /(\b(rspec|rails test|bin\/ci|npm (test|run [\w:-]*(test|lint|check|build)[\w:-]*)|pnpm (test|lint|build)|yarn (test|lint|build)|bun test|go (test|vet|build)|gofmt|rubocop|tsc|eslint|pytest|jest|vitest|cargo (test|build|clippy)|mvn|gradlew?|detekt|ktlint)\b|\bmake [\w-]*(test|lint|check|build|ci)[\w-]*\b)/;
const DECLINE_RETRIES = 2;

export function redact(s: string): string {
  return s
    .replace(/\b[0-9a-f]{40}\b/g, "<sha>")
    .replace(/\b0{7,}\b/g, "<zero-sha>")
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/\b(\w*(TOKEN|SECRET|PASSWORD|API_KEY)\w*)\b/g, "<credential-var>");
}

export interface StructuredResult<T> { data: T; costUsd: number; modelUsed: string }

interface RawOut { structured_output?: unknown; result?: string; total_cost_usd?: number; is_error?: boolean; stop_reason?: string; num_turns?: number; subtype?: string }

const DEBUG_DIR = process.env.HARNESS_DEBUG_DIR;
let debugSeq = 0;

const ANALYST_CWD = path.join(os.tmpdir(), "claude-harness-analyst");
fs.mkdirSync(ANALYST_CWD, { recursive: true });

export function neutralise(s: string): string {
  const t = s
    .replace(/mcp__unblocked__\w+/g, "research_tool")
    .replace(/\bunblocked\s+context[_-](research|get[_-]urls|get[_-]rules|search[_-]\w+)\b/gi, "research_tool")
    .replace(/\bcontext[_-](research|get[_-]urls|get[_-]rules|search[_-]\w+)\b/g, "research_tool")
    .replace(/\b(the )?Unblocked (MCP|context|research|tool|search|CLI|skill)s?( tool)?\b/gi, "the research tool")
    .replace(/\bUnblocked('s)?\b/g, (_, poss) => poss ? "the research tool's" : "the research tool");
  return t.replace(/[^.\n]*\b(not|n't|never|avoid\w*|without|no)\b[^.\n]*\bresearch tool\b[^.\n]*[.\n]|[^.\n]*\bresearch tool\b[^.\n]*\b(not|n't|never|avoid\w*|without)\b[^.\n]*[.\n]/gi, m => m.endsWith("\n") ? "\n" : "");
}

function callOnce(prompt: string, model: string, schema: object, timeoutMs: number): Promise<{ out: RawOut | null; declined: boolean; error: string }> {
  const args = [
    "-p", "--model", model, "--max-turns", "3", "--tools", "", "--strict-mcp-config", "--no-session-persistence",
    "--output-format", "json", "--json-schema", JSON.stringify(schema),
  ];
  return new Promise(resolve => {
    const chunks: Buffer[] = [], errs: Buffer[] = [];
    let status: number | null = null;
    const child = spawn(BINARY, args, { cwd: ANALYST_CWD, stdio: ["pipe", "pipe", "pipe"] });
    const timer = setTimeout(() => { child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 5000); }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => errs.push(c));
    child.on("error", err => { clearTimeout(timer); resolve({ out: null, declined: false, error: `spawn failed: ${err.message}` }); });
    child.on("close", code => {
      clearTimeout(timer);
      status = code;
      const stdout = Buffer.concat(chunks).toString(), stderr = Buffer.concat(errs).toString();
      if (DEBUG_DIR) {
        try {
          const base = `${DEBUG_DIR}/analyst-${Date.now()}-${++debugSeq}`;
          fs.writeFileSync(`${base}.prompt.txt`, prompt);
          fs.writeFileSync(`${base}.stdout.json`, stdout);
          fs.writeFileSync(`${base}.stderr.txt`, stderr);
        } catch {}
      }
      if (!stdout.length) return resolve({ out: null, declined: false, error: `exit ${status}: ${stderr.slice(0, 300)}` });
      let out: RawOut;
      try { out = JSON.parse(stdout); } catch (err) { return resolve({ out: null, declined: false, error: `unparseable output: ${(err as Error).message}` }); }
      if (out.structured_output) return resolve({ out, declined: false, error: "" });
      const msg = String(out.result ?? "");
      const detail = `stop_reason=${out.stop_reason ?? "?"} subtype=${out.subtype ?? "?"} is_error=${out.is_error ?? "?"} turns=${out.num_turns ?? "?"} result="${msg.slice(0, 200)}"`;
      resolve({ out, declined: /safeguards flagged/i.test(msg), error: detail });
    });
    child.stdin.end(prompt);
  });
}

export async function runStructured<T>(what: string, prompt: string, model: string, schema: object, timeoutMs = 15 * 60 * 1000, redactInput = true): Promise<StructuredResult<T> | null> {
  const p = redactInput ? redact(prompt) : prompt;
  let cost = 0;
  let modelUsed = model;
  let r = await callOnce(p, model, schema, timeoutMs);
  cost += r.out?.total_cost_usd ?? 0;
  for (let attempt = 1; !r.out?.structured_output && r.declined && attempt <= DECLINE_RETRIES; attempt++) {
    log(`${what}: ${model} declined the input (safeguards, intermittent); retry ${attempt}/${DECLINE_RETRIES}`);
    r = await callOnce(p, model, schema, timeoutMs);
    cost += r.out?.total_cost_usd ?? 0;
  }
  if (!r.out?.structured_output && !r.declined) {
    log(`${what}: no structured output on first attempt (${r.error}); retrying once`);
    r = await callOnce(p, model, schema, timeoutMs);
    cost += r.out?.total_cost_usd ?? 0;
  }
  if (!r.out?.structured_output && r.declined && model !== FALLBACK_MODEL) {
    log(`${what}: ${model} still declining; falling back to ${FALLBACK_MODEL}`);
    modelUsed = `${FALLBACK_MODEL} (${model} declined)`;
    r = await callOnce(p, FALLBACK_MODEL, schema, timeoutMs);
    cost += r.out?.total_cost_usd ?? 0;
  }
  if (!r.out?.structured_output) {
    log(`${what}: no structured output: ${r.error}`);
    return null;
  }
  return { data: r.out.structured_output as T, costUsd: cost, modelUsed };
}
