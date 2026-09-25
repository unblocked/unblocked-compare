// Requirement revision pass: runs after both arms, before the judge.
//
// A task's wording is not always what the team wants: the decision can live
// in a ticket thread, a PR review, chat or a design doc. When an agent finds
// that evidence, the judge should grade both agents against the team's intent,
// not penalise the one that found it (on ENG-735 the judge marked an arm down
// for following the team's decision over the ticket title).
//
// Blinded like the judge. A revision needs a verbatim quote from a tool result
// the agent actually received (research, gh, web, MCP, git history), and the
// harness checks the quote is there: an agent's own claim revises nothing.
// Revisions apply to both agents.
import fs from "node:fs";
import type { ArmResult, ComparisonResult, Condition, RequirementRevision, ReviewSpec } from "./types.ts";
import { formatCost, log } from "./util.ts";
import { neutralise, runStructured } from "./analyst.ts";
import { isExternal, isResearch } from "./impact.ts";

const RESULT_BUDGET = 4_000;
const ARM_BUDGET = 80_000;

function isEvidenceCall(name: string, input: Record<string, unknown>): boolean {
  if (isResearch(name, input) || isExternal(name, input) || name.startsWith("mcp__")) return true;
  return name === "Bash" && /\bgit\s+(log|show|blame)\b/.test(String(input.command ?? ""));
}

// The tool results an arm received from sources beyond the checked-out code.
export function evidencePool(arm: ArmResult): string {
  let jsonl = "";
  try { jsonl = fs.readFileSync(arm.run.jsonlPath, "utf8"); } catch { return ""; }
  const pending = new Map<string, string>();
  const parts: string[] = [];
  let total = 0;
  for (const line of jsonl.split("\n")) {
    let e: { type?: string; parent_tool_use_id?: unknown; message?: { content?: { type: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown }[] } };
    try { e = JSON.parse(line); } catch { continue; }
    if (typeof e.parent_tool_use_id === "string") continue;
    for (const b of e.message?.content ?? []) {
      if (e.type === "assistant" && b.type === "tool_use" && b.id && b.name && isEvidenceCall(b.name, b.input ?? {})) {
        pending.set(b.id, `${b.name} ${String(b.input?.command ?? b.input?.query ?? b.input?.url ?? JSON.stringify(b.input ?? {})).slice(0, 200)}`);
      } else if (e.type === "user" && b.type === "tool_result" && b.tool_use_id && pending.has(b.tool_use_id)) {
        const body = Array.isArray(b.content) ? b.content.map((c: { text?: string }) => c.text ?? "").join("\n") : String(b.content ?? "");
        const chunk = `--- ${pending.get(b.tool_use_id)}\n${body.slice(0, RESULT_BUDGET)}`;
        pending.delete(b.tool_use_id);
        if (total + chunk.length > ARM_BUDGET) continue;
        parts.push(chunk);
        total += chunk.length;
      }
    }
  }
  return parts.join("\n\n");
}

// Quotes are matched loosely: case, whitespace, markdown and JSON escaping
// (the Unblocked CLI prints JSON) do not count.
export function normaliseForQuote(s: string): string {
  return s
    .replace(/\\n|\\t|\\r/g, " ")
    .replace(/\\"/g, "\"")
    .replace(/[*_`>#]/g, "")
    .replace(/[“”]/g, "\"")
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const SCHEMA = {
  type: "object",
  properties: {
    revisions: { type: "array", items: { type: "object", properties: {
      index: { type: "integer" },
      revised: { type: "string" },
      reason: { type: "string" },
      quote: { type: "string" },
      agent: { type: "string", enum: ["A", "B"] },
    }, required: ["index", "revised", "reason", "quote", "agent"] } },
  },
  required: ["revisions"],
};

function prompt(task: string, spec: ReviewSpec, a: ArmResult, b: ArmResult, poolA: string, poolB: string): string {
  const block = (label: string, arm: ArmResult, pool: string) => `=================== AGENT ${label} ===================
--- Final response ---
${neutralise(arm.run.finalResponse).slice(0, 12_000)}

--- EVIDENCE: tool results agent ${label} received from research, GitHub, the web, MCP servers and git history ---
${neutralise(pool) || "(none)"}
`;
  return `Two coding agents did the same task. A judge will grade both against the numbered requirements below, which were taken from the task's wording. Sometimes the wording is not what the team wants: the decision lives in a ticket thread, a PR review, a chat discussion, a design doc or an incident, and an agent that finds it should not be graded against the wording it corrected.

Your job: find requirements whose wording the EVIDENCE shows the team intends differently, and restate them.

Rules:
- Revise a requirement only when an agent's EVIDENCE shows the team decided, documented or agreed something that changes it: a different approach, a narrower or wider scope, a case it does not cover. The quote must be copied verbatim from that agent's EVIDENCE section (a tool result), never from a final response, and must itself state the decision (at most 50 words).
- An agent's opinion, reasoning, preference or claim about what the team wants is not evidence. Code the agent wrote is not evidence.
- Change only what the evidence changes. "revised" is the requirement as the team intends it, phrased so both agents can be graded against it, at most 40 words. "reason" at most 25 words.
- Scope: when a requirement covers several cases (X or Y) and the quote speaks to only some of them, restate only those cases and keep the task's original wording for the rest, in the same revised requirement. Do not extend a decision to a case the quote does not name.
- State the behaviour the team intends, not how to build it. Do not put an implementation detail (a flag, parameter, function, file or approach) into the revised requirement unless the quoted decision itself says it must be built that way; a cause or a suggested fix in the evidence is not such a decision. Any implementation that produces the intended behaviour must be able to meet the revised requirement.
- agent: the agent whose EVIDENCE holds the quote.
- Return an empty list when nothing qualifies. Most tasks need no revision.

Refer to the agents only as "Agent A" and "Agent B".

=================== TASK ===================
${task}

=================== REQUIREMENTS (from the task's wording) ===================
${spec.requirements.map((r, i) => `${i + 1}. ${r}`).join("\n")}

${block("A", a, poolA)}
${block("B", b, poolB)}`;
}

export async function reviseRequirements(result: ComparisonResult, model: string): Promise<{ revisions: RequirementRevision[]; costUsd: number } | null> {
  const spec = result.reviewSpec;
  if (!spec?.requirements.length) return null;
  const aIsBaseline = Math.random() < 0.5;
  const first = aIsBaseline ? result.baseline : result.unblocked;
  const second = aIsBaseline ? result.unblocked : result.baseline;
  const cond = (l: "A" | "B"): Condition => ((l === "A") === aIsBaseline ? "baseline" : "unblocked");
  const pools = { A: neutralise(evidencePool(first)), B: neutralise(evidencePool(second)) };

  log(`Revisions: checking the requirements against what the agents found, with ${model}…`);
  const res = await runStructured<{ revisions: { index: number; revised: string; reason: string; quote: string; agent: "A" | "B" }[] }>(
    "Revisions", prompt(result.task, spec, first, second, pools.A, pools.B), model, SCHEMA, 15 * 60 * 1000, false);
  if (!res) return null;

  const revisions: RequirementRevision[] = [];
  const seen = new Set<number>();
  for (const r of res.data.revisions) {
    const index = r.index - 1;
    if (index < 0 || index >= spec.requirements.length || seen.has(index)) continue;
    const quote = normaliseForQuote(r.quote);
    if (quote.length < 20 || !normaliseForQuote(pools[r.agent]).includes(quote)) {
      log(`Revisions: requirement ${r.index} dropped, its quote is not in Agent ${r.agent}'s tool results: "${r.quote.slice(0, 120)}"`);
      continue;
    }
    seen.add(index);
    revisions.push({ index, revised: r.revised.trim(), reason: r.reason.trim(), quote: r.quote.trim(), foundBy: cond(r.agent) });
  }
  for (const r of revisions) log(`Revisions: requirement ${r.index + 1} → "${r.revised}" (found by ${r.foundBy}: ${r.reason})`);
  if (!revisions.length) log(`Revisions: none; ${formatCost(res.costUsd)} via ${res.modelUsed}`);
  return { revisions, costUsd: res.costUsd };
}
