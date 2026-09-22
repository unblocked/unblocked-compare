import fs from "node:fs";
import type { ArmResult, ComparisonResult, ContextImpact } from "./types.ts";
import { formatCost, log } from "./util.ts";
import { runStructured } from "./analyst.ts";
import { describeEconomics } from "./economics.ts";

interface ResearchCall { turn: number; tool: string; query: string; items: { title: string; chars: number; preview: string }[]; chars: number }

const isResearch = (name: string, input: Record<string, unknown>) =>
  name.toLowerCase().includes("unblocked") || (name === "Bash" && /^unblocked\s+context/.test(String(input.command ?? "")));

const isExternal = (name: string, input: Record<string, unknown>) =>
  /^(WebFetch|WebSearch)$/.test(name) || (name === "Bash" && /\b(gh (api|search|pr|repo)|curl |wget |rails runner|psql |mysql )/.test(String(input.command ?? "")));

function excerpt(s: string, n: number): string { s = s.replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "…" : s; }

function walkAndResearch(arm: ArmResult): { walk: string; research: ResearchCall[] } {
  let jsonl = "";
  try { jsonl = fs.readFileSync(arm.run.jsonlPath, "utf8"); } catch { return { walk: "(transcript unavailable)", research: [] }; }
  const events = jsonl.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const lines: string[] = [];
  const research: ResearchCall[] = [];
  const pendingResearch = new Map<string, ResearchCall>();
  let turn = 0;
  const seen = new Set<string>();
  for (const e of events) {
    if (typeof e.parent_tool_use_id === "string") continue;
    if (e.type === "assistant") {
      const id = String(e.message?.id ?? "");
      if (!seen.has(id)) { seen.add(id); turn++; }
      for (const b of e.message?.content ?? []) {
        if (b.type === "text" && b.text) lines.push(`T${turn} says: ${excerpt(b.text, 120)}`);
        if (b.type !== "tool_use" || !b.name) continue;
        const input = b.input ?? {};
        const arg = input.command ?? input.query ?? input.url ?? input.urls ?? input.file_path ?? input.pattern ?? JSON.stringify(input);
        if (isResearch(b.name, input)) {
          const rc: ResearchCall = { turn, tool: b.name.split(/__|::/).pop() ?? b.name, query: excerpt(String(arg), 300), items: [], chars: 0 };
          research.push(rc); pendingResearch.set(b.id, rc);
          lines.push(`T${turn} RESEARCH ${rc.tool}: ${rc.query}`);
        } else {
          lines.push(`T${turn} ${isExternal(b.name, input) ? "EXTERNAL-LOOKUP " : ""}${b.name}: ${excerpt(String(arg), 140)}`);
        }
      }
    } else if (e.type === "user" && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) {
        if (b.type !== "tool_result") continue;
        const rc = pendingResearch.get(b.tool_use_id);
        if (!rc) continue;
        pendingResearch.delete(b.tool_use_id);
        const body = Array.isArray(b.content) ? b.content.map((c: { text?: string }) => c.text ?? "").join(" ") : String(b.content ?? "");
        rc.chars = body.length;
        if (b.is_error) { rc.items.push({ title: "[ERROR]", chars: body.length, preview: excerpt(body, 200) }); continue; }
        for (const item of body.split(/\n---\n/)) {
          const title = item.match(/\*\*Title\*\*: (.*)/)?.[1]?.trim() ?? excerpt(item, 80);
          const url = item.match(/\*\*URL\*\*: (\S+)/)?.[1] ?? "";
          rc.items.push({ title: excerpt(title + (url ? ` <${url}>` : ""), 160), chars: item.length, preview: excerpt(item.replace(/\*\*Title\*\*: .*|\*\*URL\*\*: .*/g, ""), 260) });
        }
      }
    }
  }
  return { walk: lines.join("\n"), research };
}

const SCHEMA = {
  type: "object",
  properties: {
    research: { type: "array", items: { type: "object", properties: {
      turn: { type: "integer" }, query: { type: "string" },
      itemsReturned: { type: "integer" },
      itemsUsed: { type: "array", items: { type: "object", properties: { item: { type: "string" }, use: { type: "string" } }, required: ["item", "use"] } },
      value: { type: "string", enum: ["decisive", "useful", "unused", "misleading"] },
      note: { type: "string" },
    }, required: ["turn", "query", "itemsReturned", "itemsUsed", "value", "note"] } },
    impact: { type: "object", properties: {
      outcome: { type: "string", enum: ["better", "worse", "similar"] },
      contextEffect: { type: "string", enum: ["helped", "hurt", "mixed", "none"] },
      outcomeDriver: { type: "string", enum: ["context", "agent", "both"] },
      summary: { type: "string" },
      whatWouldChange: { type: "string" },
    }, required: ["outcome", "contextEffect", "outcomeDriver", "summary", "whatWouldChange"] },
    loss: { type: "object", properties: {
      baselineFound: { type: "string" },
      howFound: { type: "string", enum: ["systematic search", "chance", "n/a"] },
      unblockedFailure: { type: "string", enum: ["context misled", "stopped searching early", "context absent, never looked elsewhere", "unrelated to context", "n/a"] },
      explanation: { type: "string" },
    }, required: ["baselineFound", "howFound", "unblockedFailure", "explanation"] },
    economics: { type: "object", properties: {
      cost: { type: "string" }, time: { type: "string" }, tokens: { type: "string" },
    }, required: ["cost", "time", "tokens"] },
    discoveryAttribution: { type: "object", properties: {
      contextLed: { type: "boolean" }, evidence: { type: "string" },
    }, required: ["contextLed", "evidence"] },
  },
  required: ["research", "impact", "loss", "economics", "discoveryAttribution"],
};

function prompt(result: ComparisonResult): string {
  const u = walkAndResearch(result.unblocked);
  const b = walkAndResearch(result.baseline);
  const q = result.quality;
  const researchBlock = u.research.map(rc => `--- Research call at T${rc.turn} (${rc.tool}), ${rc.chars} chars returned ---
query: ${rc.query}
${rc.items.map((it, i) => `  [${i + 1}] ${it.title} (${it.chars} chars)\n      ${it.preview}`).join("\n") || "  (nothing returned)"}`).join("\n\n");
  const verdict = q ? `Verdict: ${q.verdict.better}. ${q.verdict.rationale}
Requirements: ${q.requirements.map(r => `"${r.requirement}" baseline=${r.baseline.status}, unblocked=${r.unblocked.status}`).join("; ")}
Findings: ${q.findings.map(f => `(${f.arm}) ${f.finding}`).join(" | ")}` : "(no quality verdict available)";

  return `Two autonomous coding agents did the same task in identical copies of one repository. The UNBLOCKED agent had a research tool (Unblocked) that searches the organisation's PRs, docs, chat, issues and other repositories; the BASELINE agent did not, but could use anything else, including the enterprise GitHub API. A blinded judge has already compared their outputs. Your job is un-blinded and narrow: what did the research context actually do?

Answer with evidence from the material below. Keep every string short; this goes on a one-page report.
1. research: for each research call — items returned, which items the UNBLOCKED agent actually used (cited, acted on in code, or followed up) and for what (each "use" ≤ 12 words), and its value: decisive, useful, unused, or misleading (led to a wrong conclusion, including a confident "nothing found"). note ≤ 15 words.
2. impact: three separate judgements, do not conflate them:
   - outcome: was the UNBLOCKED result better, worse or similar than baseline, per the judge.
   - contextEffect: what the research context itself did to that result — helped, hurt, mixed, or none. Research that supplied the facts the agent built on "helped" even if the agent then lost on other grounds; research that returned a confident absence the agent repeated "hurt".
   - outcomeDriver: whether the outcome traces mainly to the context, to the agent's own behaviour (what it chose to test, verify, check, write), or both.
   - summary: ≤ 2 sentences a customer could read, naming the decisive fact or gap.
   - whatWouldChange: 1 sentence — the single change to the context returned, or to how the agent used it, that would most have changed the result.
3. loss: only meaningful when outcome is "worse" (otherwise fill n/a and empty strings). Name what the BASELINE found that the UNBLOCKED agent never had, if anything. Say whether the baseline found it by a systematic search a careful engineer would do (e.g. a code search on the org's GitHub for the exact pattern) or by chance. Then pick the UNBLOCKED failure mode: the context misled it (returned something wrong, or a confident "nothing found" the agent repeated); the context made it stop searching early (it had a lead in hand, or an obvious next step, and treated the research as the answer); the context did not include it and the agent never looked elsewhere; or the loss is unrelated to context. explanation ≤ 2 sentences.
4. economics: three explanations, ≤ 2 sentences each, of why the arms differ in cost, time and tokens. Name only the one or two terms that moved each delta, with their size from the ECONOMICS BREAKDOWN, and what in the transcripts caused them. Say what the cost bought when it bought something. Same standard for both arms.
5. discoveryAttribution: the blinded judge recorded the UNBLOCKED agent's candidate decisive discovery (below, or "none"). Decide whether the research context led to it: contextLed is true only when a research call's returned items contained the fact, or pointed at the file, thread or PR that contained it, and the agent acted on it after that call (cite the turn and the item). If the agent found the fact by its own reading, grep, git history or reasoning, or there is no candidate, contextLed is false. evidence ≤ 25 words. This decides a tie-breaker, so be strict: a research result that merely mentioned the area is not leading the agent to the fact.

"The agent ran more tests" is agent behaviour, not context. "The agent chose sdlc because a research item showed the org roster" is context. "The agent said no prior art existed because research surfaced none, while the baseline found it with a code search" is context that hurt.

=================== TASK ===================
${result.task}

=================== ECONOMICS BREAKDOWN (core work, housekeeping removed; computed) ===================
${result.economics ? describeEconomics(result.economics) : "(not available)"}

=================== QUALITY JUDGE (blinded) ===================
${verdict}
UNBLOCKED agent's candidate decisive discovery: ${q?.discoveries?.unblocked && q.discoveries.unblocked.kind !== "none" ? `${q.discoveries.unblocked.kind}: ${q.discoveries.unblocked.fact} → ${q.discoveries.unblocked.effect} (${q.discoveries.unblocked.evidence})` : "none"}

=================== UNBLOCKED AGENT: RESEARCH CALLS AND WHAT CAME BACK ===================
${researchBlock || "(the agent made no research calls)"}

=================== UNBLOCKED AGENT: TRANSCRIPT WALK (tool calls only) ===================
${u.walk}

=================== UNBLOCKED AGENT: FINAL RESPONSE ===================
${result.unblocked.run.finalResponse}

=================== BASELINE AGENT: TRANSCRIPT WALK (tool calls only; EXTERNAL-LOOKUP marks non-repo sources) ===================
${b.walk}

=================== BASELINE AGENT: FINAL RESPONSE ===================
${result.baseline.run.finalResponse}
`;
}

export async function assessImpact(result: ComparisonResult, model: string): Promise<ContextImpact | null> {
  const p = prompt(result);
  log(`Impact: assessing context impact with ${model} (${Math.round(p.length / 1000)}k chars)…`);
  const res = await runStructured<Omit<ContextImpact, "model" | "costUsd">>("Impact", p, model, SCHEMA, 15 * 60 * 1000, false);
  if (!res) return null;
  const out: ContextImpact = { ...res.data, model: res.modelUsed, costUsd: res.costUsd };
  log(`Impact: outcome ${out.impact.outcome}, context ${out.impact.contextEffect}, driver ${out.impact.outcomeDriver}${out.loss && out.loss.unblockedFailure !== "n/a" ? `; loss: ${out.loss.unblockedFailure}` : ""}; ${formatCost(out.costUsd)} via ${res.modelUsed}`);
  return out;
}
