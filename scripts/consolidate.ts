// Consolidate every run of one ticket into a single read: patterns across the
// runs, corrected episode labels, and the context's influence before and after.
//   bun run consolidate <run-or-batch-dir> [...] [--model=fable]
// A batch directory expands to its run-N folders. One model call.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ComparisonResult } from "../src/types.ts";
import { consolidate, influencePct, measuredPct, median, type Consolidation } from "../src/consolidate.ts";
import { FONTS, REPORT_CSS } from "../src/report-style.ts";
import type { Totals } from "../src/context-effect.ts";

const args = process.argv.slice(2);
const model = args.find(a => a.startsWith("--model="))?.split("=")[1] ?? "fable";
const dirs = args.filter(a => !a.startsWith("--")).flatMap(d => {
  const runs = fs.existsSync(d) ? fs.readdirSync(d).filter(n => /^run-\d+$/.test(n)).sort() : [];
  return runs.length ? runs.map(n => path.join(d, n)) : [d];
});
if (!dirs.length) { console.error("Usage: bun run consolidate <run-or-batch-dir> [...] [--model=fable]"); process.exit(1); }

const loaded = dirs.flatMap(dir => {
  const file = path.join(dir, "result.json");
  if (!fs.existsSync(file)) { console.error(`skip ${dir}: no result.json`); return []; }
  return [{ dir: path.resolve(dir), result: JSON.parse(fs.readFileSync(file, "utf8")) as ComparisonResult }];
});
const tasks = new Set(loaded.map(x => x.result.task.trim()));
if (tasks.size > 1) console.error(`⚠ the runs have ${tasks.size} different task texts; consolidate one ticket at a time`);

const c = await consolidate(loaded, model);
if (!c) process.exit(1);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(process.cwd(), "results", `consolidated-${stamp}`);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, "consolidated.json"), JSON.stringify(c, null, 2));
const html = path.join(outDir, "report.html");
fs.writeFileSync(html, render(c));
console.log(html);
try { execFileSync("open", [html]); } catch { /* not macOS */ }

function render(c: Consolidation): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const sign = (n: number) => (n > 0 ? `+${n}%` : n < 0 ? `&minus;${-n}%` : "0%");
  const cls = (n: number) => (n < 0 ? "better" : n > 0 ? "worse" : "");
  const keys: [keyof Totals, string][] = [["costUsd", "Cost"], ["durationMs", "Time"], ["tokens", "Tokens"]];
  const metricRow = ([k, label]: [keyof Totals, string]) => {
    const before = median(c.runs.map(r => influencePct(r.before, k)));
    const after = median(c.runs.map(r => influencePct(r.after, k)));
    const measured = median(c.runs.map(r => measuredPct(r.before, k)));
    return `<tr><th scope="row">${label}</th><td><span class="fig ${cls(after)}">${sign(after)}</span><span class="range">context's influence, across runs</span></td><td><span class="fig measured">${sign(before)}</span><span class="range">per-run labels</span></td><td><span class="fig measured ${cls(measured)}">${sign(measured)}</span><span class="range">overall</span></td></tr>`;
  };
  const verdicts = c.runs.map(r => r.verdict);
  const tally = ["unblocked", "tie", "baseline"].map(v => `${verdicts.filter(x => x === v).length} ${v === "unblocked" ? "Unblocked better" : v === "tie" ? "tie" : "Baseline better"}`).join(", ");
  const [title] = c.task.trim().split("\n");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Across runs: ${esc(title.slice(0, 80))}</title>${FONTS}<style>${REPORT_CSS}</style></head><body><main class="sheet">
  <header class="hero">
    <p class="hero-meta"><span>Unblocked Compare</span><span>${c.runs.length} runs consolidated</span></p>
    <p class="hero-vs">Across runs</p>
    <h1 class="hero-task">${esc(title)}</h1>
    <p class="hero-lede">${esc(c.summary)}</p>
    <dl class="facts"><div><dt>Runs</dt><dd>${c.runs.length}</dd></div><div><dt>Verdicts</dt><dd>${tally}</dd></div><div><dt>Relabelled episodes</dt><dd>${c.reclassifications.length}</dd></div><div><dt>Judge</dt><dd>${esc(c.model)}, ${"$" + c.costUsd.toFixed(2)}</dd></div></dl>
  </header>
  <section class="section">
    <h2 class="section-title">Median across runs</h2>
    <table class="results"><thead><tr><th></th><th>With patterns across runs</th><th>Per-run labels</th><th>Overall</th></tr></thead><tbody>${keys.map(metricRow).join("")}</tbody></table>
  </section>
  <section class="section">
    <h2 class="section-title">Patterns across runs</h2>
    <div class="tool-table-wrap"><table class="tool-table"><thead><tr><th>Pattern</th><th>Runs</th><th>Consistent</th><th>Cause</th><th>Evidence</th></tr></thead><tbody>
    ${c.patterns.map(p => `<tr><td>${esc(p.description)}<div class="evidence">${p.direction === "baseline-more" ? "Baseline does it more" : "Unblocked arm does it more"}</div></td><td class="nowrap">${p.runs.join(", ")}</td><td>${p.consistent ? "yes" : "no"}</td><td>${p.cause}</td><td class="evidence">${esc(p.evidence)}</td></tr>`).join("") || `<tr><td colspan="5">No consistent pattern found.</td></tr>`}
    </tbody></table></div>
  </section>
  <section class="section">
    <h2 class="section-title">Relabelled episodes</h2>
    <div class="tool-table-wrap"><table class="tool-table"><thead><tr><th>Run</th><th>Episode</th><th>Label</th><th>Reason</th></tr></thead><tbody>
    ${c.reclassifications.map(r => { const ep = c.runs[r.run - 1].before.episodes[r.episode]; return `<tr><td>${r.run}</td><td>${esc(ep ? `${ep.arm} T${ep.fromTurn}-T${ep.toTurn}: ${ep.what}` : String(r.episode))}<div class="evidence">${ep ? `$${ep.costUsd.toFixed(2)}` : ""}</div></td><td class="nowrap">${r.from} &rarr; ${r.to}</td><td class="evidence">${esc(r.reason)}</td></tr>`; }).join("") || `<tr><td colspan="4">None.</td></tr>`}
    ${c.rejected.map(r => `<tr><td>${r.run}</td><td>episode ${r.episode}</td><td>rejected</td><td class="evidence">${esc(r.reason)}</td></tr>`).join("")}
    </tbody></table></div>
  </section>
  <section class="section">
    <h2 class="section-title">Each run</h2>
    <div class="tool-table-wrap"><table class="tool-table"><thead><tr><th>Run</th><th>Verdict</th><th>Cost influence, before &rarr; after</th><th>Overall cost</th><th>Report</th></tr></thead><tbody>
    ${c.runs.map((r, i) => `<tr><td>${i + 1}</td><td>${r.verdict}</td><td>${sign(influencePct(r.before, "costUsd"))} &rarr; ${sign(influencePct(r.after, "costUsd"))}</td><td>${sign(measuredPct(r.before, "costUsd"))}</td><td><a href="file://${esc(r.dir)}/report.html">open</a></td></tr>`).join("")}
    </tbody></table></div>
    <p class="section-note">Each run's own labels come from its impact pass. This pass may relabel an episode only when a pattern holds in at least half the runs, never reverses, and, to credit the context, ties to something that run's research returned. Numbers are recomputed per run from the per-message figures; the table shows medians.</p>
  </section>
</main></body></html>`;
}
