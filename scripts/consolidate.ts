// Consolidate every run of one ticket into one read of the context's influence.
//   bun run consolidate <run-or-batch-dir> [...] [--model=claude-opus-5-5]
// A batch directory expands to its run-N folders. One model call.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { ComparisonResult } from "../src/types.ts";
import { CONSOLIDATE_MODEL, consolidate, type Consolidation, type MetricRead } from "../src/consolidate.ts";
import { FONTS, REPORT_CSS } from "../src/report-style.ts";

const args = process.argv.slice(2);
const model = args.find(a => a.startsWith("--model="))?.split("=")[1] ?? CONSOLIDATE_MODEL;
const dirs = args.filter(a => !a.startsWith("--")).flatMap(d => {
  const runs = fs.existsSync(d) ? fs.readdirSync(d).filter(n => /^run-\d+$/.test(n)).sort() : [];
  return runs.length ? runs.map(n => path.join(d, n)) : [d];
});
if (!dirs.length) { console.error(`Usage: bun run consolidate <run-or-batch-dir> [...] [--model=${CONSOLIDATE_MODEL}]`); process.exit(1); }

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
  const cls = (n: number | null) => (n === null ? "" : n < 0 ? " better" : n > 0 ? " worse" : "");
  const label = { costUsd: "Cost", durationMs: "Time", tokens: "Tokens" } as const;
  const runsList = (ns: number[]) => ns.length ? `run${ns.length > 1 ? "s" : ""} ${ns.join(", ")}` : "no runs";
  const cell = (m: MetricRead) => `<div class="cell"><div class="cell-label">${label[m.key]}</div>
    <div class="cell-fig${cls(m.influence)}">${m.influence === null ? "Mixed" : sign(m.influence)}</div>
    <div class="cell-sub">${m.influence === null ? "No consistent direction across runs" : "Context's influence across runs"}</div>
    <div class="cell-sub">${m.range ? `Range ${sign(m.range[0])} to ${sign(m.range[1])}, ${runsList(m.comparableRuns)}` : ""}</div></div>`;
  const metricRow = (m: MetricRead) => `<tr><th scope="row">${label[m.key]}</th>
    <td><span class="fig${cls(m.influence)}">${m.influence === null ? "Mixed" : sign(m.influence)}</span><span class="range">${m.consistent ? "consistent across runs" : "changes direction between runs"}</span></td>
    <td>${m.measured.map(sign).join(", ")}<span class="range">overall, per comparable run</span></td>
    <td>${m.carvedOut.some(x => x !== 0) ? m.carvedOut.map(sign).join(", ") : "none"}<span class="range">explained by consistent non-context causes</span></td>
    <td>${sign(m.byContextPatterns)}<span class="range">named context patterns</span></td>
    <td>${sign(m.perRunLabels)}<span class="range">each run's own labels</span></td></tr>`;
  const verdicts = ["unblocked", "tie", "baseline"].map(v => `${c.verdicts.filter(x => x === v).length} ${v === "unblocked" ? "Unblocked better" : v === "tie" ? "tie" : "Baseline better"}`).join(", ");
  const [title] = c.task.trim().split("\n");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Across runs: ${esc(title.slice(0, 80))}</title>${FONTS}<style>${REPORT_CSS}</style></head><body><main class="sheet">
  <header class="hero">
    <p class="hero-meta"><span>Unblocked Compare</span><span>${c.verdicts.length} runs consolidated</span></p>
    <p class="hero-vs">Across runs</p>
    <h1 class="hero-task">${esc(title)}</h1>
    <p class="hero-lede">${esc(c.summary)}</p>
    <div class="board"><div class="cell"><div class="cell-label">Quality</div><div class="cell-fig word">${c.verdicts.filter(v => v === "unblocked").length}&thinsp;/&thinsp;${c.verdicts.length}</div><div class="cell-sub">${verdicts}</div></div>${c.metrics.map(cell).join("")}</div>
    <dl class="facts"><div><dt>Runs</dt><dd>${c.verdicts.length}</dd></div><div><dt>Comparable</dt><dd>${c.runs.filter(r => r.comparable).length}</dd></div><div><dt>Consistent patterns</dt><dd>${c.patterns.filter(p => p.consistent).length}</dd></div><div><dt>Judge</dt><dd>${esc(c.model)}, $${c.costUsd.toFixed(2)}</dd></div></dl>
  </header>
  <section class="section">
    <h2 class="section-title">How the numbers are read</h2>
    <table class="results"><thead><tr><th></th><th>Context's influence</th><th>Overall</th><th>Not the context</th><th>Context patterns</th><th>Per-run labels</th></tr></thead><tbody>${c.metrics.map(metricRow).join("")}</tbody></table>
    <p class="section-note">The context is the only systematic difference between the arms, so a difference that points the same way in every comparable run (three in four with four or more runs) is read as the context's doing, less anything the judge traced to a consistent cause other than the context. "Mixed" means the direction changes between runs: ordinary variance, no consistent influence. "Per-run labels" is what each run's own analysis attributed, for comparison.</p>
  </section>
  <section class="section">
    <h2 class="section-title">Patterns across runs</h2>
    <div class="tool-table-wrap"><table class="tool-table"><thead><tr><th>Pattern</th><th>Cause</th><th>Runs</th><th>Evidence</th></tr></thead><tbody>
    ${c.patterns.map(p => `<tr${p.consistent && p.cause === "context" ? ` class="highlight-row"` : ""}><td>${esc(p.description)}<div class="evidence">${p.direction === "baseline-more" ? "Baseline does it more" : "Unblocked arm does it more"}${p.consistent ? ", consistent" : ", not consistent"}</div></td><td class="nowrap">${p.cause}</td><td class="nowrap">${p.runs.join(", ")}</td><td class="evidence">${esc(p.evidence)}</td></tr>`).join("") || `<tr><td colspan="4">No pattern found.</td></tr>`}
    </tbody></table></div>
  </section>
  <section class="section">
    <h2 class="section-title">Each run</h2>
    <div class="tool-table-wrap"><table class="tool-table"><thead><tr><th>Run</th><th>Verdict</th><th>Comparable</th><th>Why</th><th>Report</th></tr></thead><tbody>
    ${c.runs.map((r, i) => `<tr><td>${r.run}</td><td>${c.verdicts[i]}</td><td>${r.comparable ? "yes" : "no"}</td><td class="evidence">${esc(r.reason)}</td><td><a href="file://${esc(c.dirs[i])}/report.html">open</a></td></tr>`).join("")}
    </tbody></table></div>
  </section>
</main></body></html>`;
}
