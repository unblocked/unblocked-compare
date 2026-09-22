import type { ArmResult, Condition, ReviewPass, ReviewRequirement, ReviewSpec } from "./types.ts";
import { formatCost, log } from "./util.ts";
import { neutralise, runStructured } from "./analyst.ts";

const DIFF_BUDGET = 200_000;

const SPEC_SCHEMA = {
  type: "object",
  properties: { requirements: { type: "array", items: { type: "string" } } },
  required: ["requirements"],
};

export async function extractRequirements(task: string, model: string): Promise<ReviewSpec | null> {
  log(`Review: extracting the task's requirements with ${model}…`);
  const prompt = `A change will be checked against this task. List every explicit requirement and acceptance criterion the task states, one per entry, ≤ 20 words each, in the order the task gives them. Include deliverables the task names (for example tests, a changelog entry) as their own entries. Keep an "either X or Y" criterion as one entry that names both alternatives; never split alternatives into separate requirements, and never split one criterion into a condition and its consequence. Do not add requirements the task does not state, and do not restate motivation as a requirement.

=================== TASK ===================
${task}
`;
  const res = await runStructured<{ requirements: string[] }>("Requirements", prompt, model, SPEC_SCHEMA, 5 * 60 * 1000, false);
  if (!res) return null;
  const requirements = res.data.requirements.map(r => r.trim()).filter(Boolean);
  log(`Review: ${requirements.length} requirement(s) — ${requirements.map((r, i) => `${i + 1}. ${r}`).join("; ")}; ${formatCost(res.costUsd)} via ${res.modelUsed}`);
  return { model: res.modelUsed, costUsd: res.costUsd, requirements, adjudications: [] };
}

const waivedIndices = (spec: ReviewSpec) => new Set(spec.adjudications.filter(a => a.waived).map(a => a.index));
const exclusionsFor = (spec: ReviewSpec, i: number) => spec.adjudications.filter(a => a.index === i && !a.waived && a.excludes).map(a => a.excludes as string);

const SCHEMA = {
  type: "object",
  properties: {
    requirements: { type: "array", items: { type: "object", properties: {
      index: { type: "integer" },
      status: { type: "string", enum: ["met", "partial", "unmet"] },
      note: { type: "string" },
    }, required: ["index", "status", "note"] } },
    summary: { type: "string" },
  },
  required: ["requirements", "summary"],
};

function prompt(task: string, arm: ArmResult, round: number, previous: ReviewPass | null, spec: ReviewSpec, disputed: string): string {
  const truncated = arm.diff.length > DIFF_BUDGET;
  const diff = truncated ? arm.diff.slice(0, DIFF_BUDGET) + `\n… (diff truncated here; ${arm.diff.length - DIFF_BUDGET} more characters not shown, in files not visible above)` : arm.diff;
  const waived = waivedIndices(spec);
  const list = spec.requirements.map((r, i) => `${i + 1}. ${r}${waived.has(i) ? "   [WAIVED — do not check; report it as met]" : exclusionsFor(spec, i).length ? `   [does not cover: ${exclusionsFor(spec, i).join("; ")}]` : ""}`).join("\n");
  const waiverNotes = spec.adjudications.map(a => `- Requirement ${a.index + 1}: ${a.waived ? "waived" : a.excludes ? `stands, but does not cover ${a.excludes}` : "dispute rejected, still required"} — ${a.reason}`).join("\n");
  const prior = previous ? `
This is round ${round}. In round ${previous.round} you marked: ${previous.requirements.map((r, i) => `${i + 1} ${r.status}${r.status === "met" || r.status === "waived" ? "" : ` (${r.note})`}`).join("; ")}. Judge the current state, not the history.${disputed ? `
The engineer disputes part of that: """${neutralise(disputed)}""". Where they say a requirement is already satisfied, re-check it against the diff and description and grade what you find. Where they say a requirement should not apply, that is decided elsewhere; grade it as you find it.` : ""}` : "";
  return `You are checking whether an engineer's change meets the requirements of the task it was written for. You have the task, the engineer's summary of the change, and the diff of their working tree against the base branch. Nothing has been committed, pushed or branched: the diff is uncommitted work, and its existence says nothing about commits or branches.

Your only job is classification. For each numbered requirement below, mark it:
- met: the diff delivers it for every case the task covers;
- partial: the diff delivers it for some cases the task covers, not all;
- unmet: the diff does not deliver it.
With a note ≤ 25 words. For met, cite where in the diff. For partial or unmet, say exactly which case or part is missing, citing the diff or the description. Judge from the diff; a claim in the description that the diff does not show is not evidence. Exception: if the diff says it was truncated and the description credibly claims something was done in a file the truncation notice says is not shown, mark that requirement unmet with the note "cannot verify, diff truncated before the relevant file" rather than a note that says it is missing — and do not repeat the same conclusion round after round if the description keeps pointing at the same file; each round the diff may show different files depending on what changed. The exception is a requirement about process that a diff cannot show (not committing, not branching, how something was run): accept the description unless the diff contradicts it.

Do not add requirements, do not comment on code quality, style, tests, naming, logging or robustness beyond what a requirement states, and do not suggest changes or extra work. If the description argues that a requirement should not apply, do not waive it: mark it as you find it and quote the argument in the note; disputes are decided elsewhere.
${prior}
${list}
${waiverNotes ? `\nDecisions already made on disputes:\n${waiverNotes}\n` : ""}
summary: ≤ 2 sentences, which requirements are not met and why.

=================== TASK ===================
${task}

=================== THE ENGINEER'S SUMMARY ===================
${neutralise(arm.run.finalResponse)}

=================== DIFF (${arm.diffStats.filesChanged} files, +${arm.diffStats.linesAdded} -${arm.diffStats.linesRemoved}) ===================
${neutralise(diff)}
`;
}

export type ReviewOutput = { requirements: ReviewRequirement[]; waiversInForce: number[]; mergeable: boolean; summary: string; costUsd: number; model: string };

function alignRequirements(spec: ReviewSpec, answers: { index: number; status: "met" | "partial" | "unmet"; note: string }[]): ReviewRequirement[] {
  const waived = waivedIndices(spec);
  const byIndex = new Map(answers.map(a => [a.index - 1, a]));
  return spec.requirements.map((requirement, i) => {
    if (waived.has(i)) return { index: i, requirement, status: "waived" as const, note: spec.adjudications.find(a => a.index === i && a.waived)?.reason ?? "waived" };
    const a = byIndex.get(i);
    return a ? { index: i, requirement, status: a.status, note: a.note } : { index: i, requirement, status: "unmet" as const, note: "(not assessed by the reviewer)" };
  });
}

export const isMergeable = (requirements: ReviewRequirement[]) =>
  requirements.every(x => x.status === "met" || x.status === "waived");

export async function reviewDraft(task: string, arm: ArmResult, model: string, round: number, previous: ReviewPass | null, spec: ReviewSpec, disputed = ""): Promise<ReviewOutput | null> {
  log(`[${arm.condition}] Review round ${round}: checking requirements with ${model}…`);
  const res = await runStructured<{ requirements: { index: number; status: "met" | "partial" | "unmet"; note: string }[]; summary: string }>(`Review:${arm.condition}:${round}`, prompt(task, arm, round, previous, spec, disputed), model, SCHEMA, 15 * 60 * 1000, false);
  if (!res) return null;
  const requirements = alignRequirements(spec, res.data.requirements);
  const mergeable = isMergeable(requirements);
  log(`[${arm.condition}] Review round ${round}: ${mergeable ? "all requirements met" : "not yet"}; ${requirements.filter(r => r.status === "met").length} met / ${requirements.filter(r => r.status === "partial").length} partial / ${requirements.filter(r => r.status === "unmet").length} unmet / ${requirements.filter(r => r.status === "waived").length} waived; ${formatCost(res.costUsd)} via ${res.modelUsed}`);
  return { requirements, waiversInForce: [...waivedIndices(spec)].sort((a, b) => a - b), mergeable, summary: res.data.summary, costUsd: res.costUsd, model: res.modelUsed };
}

const DISPUTE_SCHEMA = {
  type: "object",
  properties: { decisions: { type: "array", items: { type: "object", properties: {
    index: { type: "integer" },
    ruling: { type: "string", enum: ["waive", "exclude", "reject"] },
    excludes: { type: "string" },
    reason: { type: "string" },
  }, required: ["index", "ruling", "excludes", "reason"] } } },
  required: ["decisions"],
};

export async function adjudicateDisputes(task: string, spec: ReviewSpec, disputed: string, by: Condition, round: number, model: string): Promise<number> {
  const closed = new Set(spec.adjudications.filter(a => a.waived || !a.excludes).map(a => a.index));
  const open = spec.requirements.map((_, i) => i).filter(i => !closed.has(i));
  if (!open.length || !disputed.trim()) return 0;
  log(`[${by}] Review round ${round}: the agent disputed part of the review; adjudicating with ${model}…`);
  const prior = spec.adjudications.map(a => `- Requirement ${a.index + 1}: ${a.waived ? "waived" : a.excludes ? `does not cover ${a.excludes}` : "dispute rejected"} — ${a.reason}`).join("\n");
  const p = `A task was given to an engineer, whose change is being checked against the numbered requirements below. In their latest revision the engineer disputes part of the check. Rule on each requirement the dispute addresses, by number:
- "waive": the requirement does not apply to this task at all, for anyone. Only when the dispute shows it is wrong for this codebase, contradicts another requirement, or would do harm if implemented.
- "exclude": the requirement stands, but a specific case the engineer names is outside it. Name that case in "excludes", in ≤ 8 words (for example "hidden reviews", "cancelled reviews"). Use this when the dispute shows the case cannot occur under the task's trigger, or that covering it would break an existing rule of the codebase, and the rest of the requirement is unaffected.
- "reject": the dispute does not hold; the requirement stands in full.
Do not rule on "already satisfied": you cannot see the diff, and the next check will re-verify that. "It is out of scope", "the wording does not fit" or "it can be a follow-up" are not grounds when the task states the requirement. Return one decision per requirement the dispute addresses; leave the others out; for "waive" and "reject" set "excludes" to an empty string. reason ≤ 25 words. Your ruling will bind every check of this task, for every engineer, from now on.

=================== TASK ===================
${task}

=================== REQUIREMENTS ===================
${spec.requirements.map((r, i) => `${i + 1}. ${r}${open.includes(i) ? "" : "   (already decided)"}`).join("\n")}
${prior ? `\nEarlier rulings:\n${prior}\n` : ""}
=================== THE ENGINEER'S DISPUTE ===================
${neutralise(disputed)}
`;
  const res = await runStructured<{ decisions: { index: number; ruling: "waive" | "exclude" | "reject"; excludes: string; reason: string }[] }>(`Adjudicate:${by}:${round}`, p, model, DISPUTE_SCHEMA, 5 * 60 * 1000, false);
  if (!res) { log(`[${by}] Review round ${round}: adjudication failed; the requirements stand as checked`); return 0; }
  if (!res.data.decisions.length) log(`[${by}] Review round ${round}: adjudicator returned no decision; the requirements stand as checked`);
  for (const d of res.data.decisions) {
    const i = d.index - 1;
    if (!open.includes(i)) { log(`[${by}] Review round ${round}: adjudicator ruled on requirement ${d.index}, which is not open; ignored`); continue; }
    const excludes = d.ruling === "exclude" ? d.excludes.trim() : "";
    if (d.ruling === "exclude" && !excludes) continue;
    spec.adjudications.push({ index: i, waived: d.ruling === "waive", ...(excludes ? { excludes } : {}), reason: d.reason, disputedBy: by, round });
    log(`[${by}] Review round ${round}: requirement ${i + 1} "${spec.requirements[i]}" ${d.ruling === "waive" ? "WAIVED for both arms" : d.ruling === "exclude" ? `does not cover "${excludes}" (both arms)` : "dispute rejected"} — ${d.reason}`);
  }
  spec.costUsd += res.costUsd;
  return res.costUsd;
}

export function applyWaivers(arm: ArmResult, spec: ReviewSpec): void {
  const rv = arm.review;
  if (!rv || !rv.passes.length) return;
  const last = rv.passes[rv.passes.length - 1];
  const waived = waivedIndices(spec);
  for (const r of last.requirements) {
    if (r.index !== undefined && waived.has(r.index) && r.status !== "waived") {
      r.status = "waived";
      r.note = `waived for both arms: ${spec.adjudications.find(a => a.index === r.index && a.waived)?.reason ?? ""}`;
    }
  }
  last.mergeable = isMergeable(last.requirements);
  rv.finalMergeable = last.mergeable;
}

export function fixPrompt(round: number, r: ReviewOutput): string {
  const open = r.requirements.filter(x => x.status === "unmet" || x.status === "partial").map(x => `- ${x.requirement} — ${x.status}: ${x.note}`).join("\n");
  return `Your change has been checked against the task's requirements (round ${round}). These are not yet met:
${open || "(none)"}

Make the change meet each of them. Do not take on work beyond what these requirements need. If you believe one is wrong — it does not apply to this codebase, is already satisfied in a way the check missed, or would do harm — do not silently ignore it: put a section headed "Disputed:" in your final response that names it and gives your reason, so it can be decided. Where you are unsure how the codebase handles something, research it with the tools you used before rather than guessing. Keep to the conventions you already followed. Re-run the checks you ran before and wait for them to finish. Do not rebase, commit, branch, or tidy unrelated files. End with a short summary of what changed.`;
}

export function disputedSection(finalResponse: string): string {
  const m = finalResponse.match(/(?:^|\n)\s*(?:#+\s*)?\**Disputed:?\**\s*\n?([\s\S]{0,2000})/i);
  let text = m ? m[1] : "";
  const end = text.search(/\n\s*(#+\s|\*\*[^*\n]{1,80}\*\*:?\s*\n|[A-Z][A-Za-z ]{2,40}:\s*\n)/);
  if (end >= 0) text = text.slice(0, end);
  text = text.trim();
  return /^[\s*_]*(none|nothing|n\/a|no disputes?|no)\b/i.test(text) ? "" : text;
}
