// Report styling: a light sheet under a deep plum hero. Raspberry is the
// context arm and "better"; burnt amber is "worse"; the Baseline is grey-violet.
// Bricolage Grotesque for display, Atkinson Hyperlegible for reading.
export const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Mono:wght@400;600&family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=Atkinson+Hyperlegible+Next:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap">`;

export const REPORT_CSS = `
  :root {
    --ground: #f2ecef;
    --paper: #ffffff;
    --ink: #1e1220;
    --text: #1e1220;
    --text-muted: #6b5f6e;
    --rule: #e2d9df;
    --rule-soft: #f0eaee;
    --tint: #f8f4f6;
    --context: #c2185b;
    --context-tint: #fce8f0;
    --baseline: #8a8196;
    --better: #c2185b;
    --worse: #b45309;
    --green: #1f7a4d;
    --green-tint: #e6f3ec;
    --red: #b42318;
    --red-tint: #fbe9e7;
    --yellow: #94640a;
    --band: #2a0a1f;
    --band-ink: #fbeef3;
    --band-muted: rgba(251, 238, 243, 0.62);
    --band-rule: rgba(251, 238, 243, 0.16);
    --band-better: #ff8fbd;
    --band-worse: #f6c177;
    --gold: #e9c98b;
    --display: "Bricolage Grotesque", "Atkinson Hyperlegible Next", system-ui, sans-serif;
    --sans: "Atkinson Hyperlegible Next", system-ui, -apple-system, "Segoe UI", sans-serif;
    --mono: "Atkinson Hyperlegible Mono", ui-monospace, "SF Mono", Menlo, monospace;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: var(--sans); background: var(--ground); color: var(--ink); font-size: 15px; line-height: 1.55; font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased; }
  code, pre { font-family: var(--mono); }
  a { color: var(--context); text-underline-offset: 2px; }
  :focus-visible { outline: 2px solid var(--context); outline-offset: 2px; }

  body { background: radial-gradient(1200px 640px at 50% -220px, #f3cddd, transparent 70%), var(--ground); }
  .sheet { max-width: 1000px; margin: 40px auto 64px; padding: 0 64px 44px; background: var(--paper); border-radius: 14px; overflow: hidden; box-shadow: 0 1px 0 rgba(42, 10, 31, 0.06), 0 50px 100px -40px rgba(42, 10, 31, 0.5); }

  .masthead { margin: 0 -64px 44px; padding: 52px 64px 36px; background: var(--band); color: var(--band-ink); }
  .product { font-size: 14px; color: var(--gold); margin-bottom: 10px; }
  .masthead h1 { font-family: var(--display); font-size: 64px; line-height: 0.98; font-weight: 800; letter-spacing: -0.035em; font-variation-settings: "opsz" 96; margin-bottom: 36px; }
  .facts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px 24px; padding-top: 18px; border-top: 1px solid var(--band-rule); }
  .facts dt { font-size: 13px; color: var(--band-muted); }
  .facts dd { font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }

  .section { margin-bottom: 44px; }
  .section-title { font-family: var(--display); font-size: 28px; font-weight: 700; line-height: 1.15; letter-spacing: -0.02em; margin-bottom: 16px; }
  .section-sub { font-size: 14px; font-weight: 400; color: var(--text-muted); margin-left: 8px; }
  .section-note { font-size: 14px; color: var(--text-muted); margin: 0 0 16px; max-width: 72ch; }
  .task { font-size: 16px; line-height: 1.65; max-width: 72ch; padding: 2px 0 2px 18px; border-left: 3px solid var(--context); white-space: pre-wrap; overflow-wrap: anywhere; }

  /* Hero: task, verdict, scoreboard */
  .hero { position: relative; margin: 0 -64px 52px; padding: 40px 64px 34px; color: var(--band-ink); background: radial-gradient(900px 420px at 100% 0%, rgba(194, 24, 91, 0.45), transparent 65%), var(--band); }
  .hero-meta { display: flex; justify-content: space-between; font-size: 13px; color: var(--band-muted); margin-bottom: 44px; }
  .hero-meta span:first-child { color: var(--gold); font-weight: 600; }
  .hero-vs { font-size: 15px; color: var(--gold); margin-bottom: 8px; }
  .hero-task { font-family: var(--display); font-size: 46px; line-height: 1.02; font-weight: 800; letter-spacing: -0.035em; font-variation-settings: "opsz" 96; max-width: 22ch; margin-bottom: 14px; text-wrap: balance; }
  .hero-task-rest { font-size: 15px; line-height: 1.6; color: var(--band-muted); max-width: 70ch; white-space: pre-wrap; overflow-wrap: anywhere; }
  .hero-lede { font-family: var(--display); font-size: 30px; line-height: 1.2; font-weight: 500; letter-spacing: -0.02em; max-width: 34ch; margin: 48px 0 40px; padding-top: 28px; border-top: 1px solid var(--band-rule); text-wrap: balance; }
  .board { display: grid; grid-template-columns: 1.15fr 1fr 1fr 1fr; margin-bottom: 40px; }
  .cell { min-width: 0; padding: 0 18px; border-left: 1px solid var(--band-rule); }
  .cell:first-child { padding-left: 0; border-left: none; }
  .cell-label { font-size: 14px; color: var(--band-muted); margin-bottom: 6px; }
  .cell-fig { font-family: var(--display); font-size: 74px; line-height: 0.95; font-weight: 800; letter-spacing: -0.05em; font-variation-settings: "opsz" 96; color: var(--gold); margin-bottom: 14px; font-variant-numeric: tabular-nums; }
  .cell-fig.word { font-size: 64px; padding-top: 14px; }
  .cell-fig.better { color: var(--band-better); }
  .cell-fig.worse { color: var(--band-worse); }
  .cell-sub { font-size: 13px; line-height: 1.5; color: var(--band-muted); }
  .hero .facts { padding-top: 18px; }
  .hero-lede, .board, .hero .facts { animation: rise 0.7s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
  .board { animation-delay: 0.1s; }
  .hero .facts { animation-delay: 0.2s; }
  @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .hero-lede, .board, .hero .facts { animation: none; } }

  /* Summary */
  .lede { font-family: var(--display); font-size: 32px; line-height: 1.18; font-weight: 600; letter-spacing: -0.022em; max-width: 36ch; margin-bottom: 36px; text-wrap: balance; }
  .results { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
  .results th, .results td { text-align: left; vertical-align: top; padding: 16px 16px 16px 0; border-bottom: 1px solid var(--rule); }
  .results thead th { font-size: 13px; font-weight: 600; color: var(--text-muted); padding-top: 0; padding-bottom: 8px; border-bottom: 2px solid var(--ink); }
  .results th, .results td { padding-top: 22px; padding-bottom: 22px; }
  .results tbody th { font-family: var(--display); font-size: 20px; font-weight: 700; letter-spacing: -0.01em; width: 110px; padding-top: 30px; }
  .results td:nth-child(2) { width: 190px; }
  .results td:nth-child(3) { width: 150px; }
  .fig { display: block; font-family: var(--display); font-size: 52px; font-weight: 800; line-height: 1; letter-spacing: -0.04em; font-variation-settings: "opsz" 96; }
  .fig.better { color: var(--better); }
  .fig.worse { color: var(--worse); }
  .fig.measured { font-size: 30px; font-weight: 600; letter-spacing: -0.025em; color: var(--text-muted); padding-top: 14px; }
  .range { display: block; font-size: 13px; color: var(--text-muted); margin-top: 4px; }
  .quality-row .fig { font-size: 40px; }
  .quality-row .range { font-size: 14px; }

  .split { position: relative; display: flex; height: 26px; margin: 12px 0 12px; background: var(--tint); border-radius: 4px; }
  .split-neg, .split-pos { width: 50%; display: flex; }
  .split-neg { flex-direction: row-reverse; }
  .seg { display: block; height: 100%; animation: grow 0.9s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
  .split-neg .seg { transform-origin: right center; }
  .split-pos .seg { transform-origin: left center; }
  .split-neg .seg:last-child { border-radius: 4px 0 0 4px; }
  .split-pos .seg:last-child { border-radius: 0 4px 4px 0; }
  .results tr:nth-child(3) .seg { animation-delay: 0.12s; }
  .results tr:nth-child(4) .seg { animation-delay: 0.24s; }
  .split-total { animation: fade 0.4s 0.8s both; }
  @keyframes grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .seg, .split-total { animation: none; } }
  .seg-influence, .key-influence { background: var(--context); }
  .seg-own, .key-own { background: var(--baseline); }
  .seg-other, .key-other { background: #ddd3dc; }
  .split-zero { position: absolute; left: 50%; top: -4px; bottom: -4px; width: 1px; background: var(--ink); }
  .split-total { position: absolute; top: -7px; bottom: -7px; width: 3px; margin-left: -1px; background: var(--ink); border-radius: 2px; }
  .split-text { font-size: 13px; color: var(--text-muted); line-height: 1.6; }
  .split-text span { white-space: nowrap; margin-right: 10px; }
  .key { display: inline-block; width: 9px; height: 9px; margin: 0 5px 0 0; vertical-align: 0; font-style: normal; }

  .points { max-width: 72ch; margin: 0 0 20px 20px; font-size: 16px; line-height: 1.6; }
  .points li { margin-bottom: 6px; padding-left: 4px; }
  .points li::marker { color: var(--context); }

  details > summary { cursor: pointer; }
  .ledger { margin-top: 12px; }
  .ledger > summary { font-size: 14px; font-weight: 600; color: var(--context); padding: 6px 0; margin-bottom: 8px; }
  .ledger .section-note { margin-top: 10px; }

  .full-report { margin: 8px 0 40px; border-top: 2px solid var(--ink); }
  .full-report > summary { list-style: none; display: flex; align-items: baseline; gap: 14px; padding: 20px 0; font-family: var(--display); font-size: 26px; font-weight: 700; letter-spacing: -0.02em; }
  .full-report > summary span { font-family: var(--sans); letter-spacing: 0; }
  .full-report > summary::-webkit-details-marker { display: none; }
  .full-report > summary::before { content: "+"; display: inline-block; width: 22px; font-weight: 500; color: var(--context); transition: transform 0.2s; }
  .full-report[open] > summary::before { content: "\\2212"; }
  .full-report > summary span { font-size: 14px; font-weight: 400; color: var(--text-muted); }
  .full-report[open] > summary { margin-bottom: 28px; border-bottom: 1px solid var(--rule); }

  /* Stat blocks (reports without a Summary) */
  .hero-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; margin-bottom: 36px; }
  .hero-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .hero-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .hero-card { border-top: 2px solid var(--ink); padding-top: 10px; }
  .hero-label { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
  .hero-value { font-family: var(--display); font-size: 44px; font-weight: 800; line-height: 1.05; letter-spacing: -0.035em; }
  .hero-value.positive { color: var(--better); }
  .hero-value.negative { color: var(--worse); }
  .hero-detail { font-size: 13px; color: var(--text-muted); }

  /* Paired bars */
  .comparison-row { display: grid; grid-template-columns: 170px 1fr; gap: 16px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--rule-soft); }
  .comp-label { font-size: 14px; font-weight: 600; }
  .comp-note { font-size: 12px; font-weight: 400; color: var(--text-muted); line-height: 1.35; margin-top: 2px; }
  .bar-group { display: flex; flex-direction: column; gap: 4px; }
  .bar-row { display: flex; align-items: center; gap: 10px; }
  .bar-tag { width: 130px; flex-shrink: 0; font-size: 13px; color: var(--text-muted); }
  .bar-tag.better, .bar-tag.worse { color: var(--context); font-weight: 600; }
  .bar-track { flex: 1; height: 20px; }
  .bar-fill { height: 100%; min-width: fit-content; display: flex; align-items: center; padding: 0 8px; font-size: 13px; font-weight: 600; white-space: nowrap; }
  .bar-fill.baseline { background: #ebe4ea; color: var(--ink); }
  .bar-fill.better { background: var(--context-tint); color: var(--context); box-shadow: inset 3px 0 0 var(--context); }
  .bar-fill.worse { background: var(--context-tint); color: var(--worse); box-shadow: inset 3px 0 0 var(--context); }

  /* Arm details */
  .arm-section { border: 1px solid var(--rule); margin-bottom: 20px; }
  .arm-section.context-arm { border-left: 3px solid var(--context); }
  .arm-header { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; flex-wrap: wrap; padding: 12px 16px; border-bottom: 1px solid var(--rule); background: var(--tint); }
  .arm-name { font-size: 16px; font-weight: 700; }
  .arm-meta { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .arm-stat { padding: 14px 16px; border-right: 1px solid var(--rule-soft); }
  .arm-stat:last-child { border-right: none; }
  .arm-stat-val { font-family: var(--display); font-size: 24px; font-weight: 700; letter-spacing: -0.02em; }
  .arm-stat-label { font-size: 13px; color: var(--text-muted); }
  .arm-tokens { display: flex; flex-wrap: wrap; gap: 6px 20px; padding: 10px 16px; border-top: 1px solid var(--rule-soft); font-size: 13px; color: var(--text-muted); }
  .arm-tokens span { color: var(--ink); font-weight: 600; }

  /* Tables */
  .tool-table-wrap { overflow-x: auto; border-top: 2px solid var(--ink); }
  .tool-table { width: 100%; border-collapse: collapse; font-size: 14px; }
  .tool-table th { text-align: left; font-size: 13px; font-weight: 600; color: var(--text-muted); padding: 8px 12px 8px 0; border-bottom: 1px solid var(--rule); }
  .tool-table td { padding: 9px 12px 9px 0; border-bottom: 1px solid var(--rule-soft); vertical-align: top; }
  .ledger .tool-table, .arm-section .tool-table { border-top: 2px solid var(--ink); }
  .arm-section .tool-table { border-top: none; }
  .arm-section .tool-table th:first-child, .arm-section .tool-table td:first-child { padding-left: 16px; }
  .tool-table td:first-child, .nowrap { white-space: nowrap; }
  .workings { margin-bottom: 20px; }
  .workings td:not(:first-child), .workings th:not(:first-child) { text-align: right; width: 110px; white-space: nowrap; }
  .total-row td { font-weight: 700; border-top: 1px solid var(--ink); }
  .highlight-row td { background: var(--context-tint); }
  .highlight-row td:first-child { box-shadow: inset 3px 0 0 var(--context); padding-left: 8px; }

  .met { font-weight: 600; font-size: 13px; }
  .met-met { color: var(--green); } .met-partial { color: var(--yellow); } .met-unmet { color: var(--red); }
  .score { font-weight: 700; }
  .evidence { font-size: 13px; color: var(--text-muted); margin-top: 3px; line-height: 1.5; }

  .verdict { border-left: 3px solid var(--baseline); padding: 4px 0 4px 16px; margin-bottom: 20px; font-size: 15px; max-width: 80ch; }
  .verdict.positive { border-left-color: var(--better); }
  .verdict.negative { border-left-color: var(--worse); }
  .verdict-head { font-weight: 700; font-size: 17px; margin-bottom: 4px; }
  .verdict-conf { font-weight: 400; font-size: 14px; color: var(--text-muted); }
  .findings { display: flex; flex-direction: column; }
  .finding { padding: 10px 0; border-bottom: 1px solid var(--rule-soft); font-size: 14px; }
  .finding-arm { font-size: 13px; font-weight: 700; margin-right: 8px; }
  .finding-arm.unblocked { color: var(--context); } .finding-arm.baseline { color: var(--text-muted); }

  .unblocked-grid { display: flex; flex-direction: column; border-top: 2px solid var(--ink); }
  .unblocked-card { display: flex; gap: 14px; align-items: baseline; padding: 9px 0; border-bottom: 1px solid var(--rule-soft); }
  .unblocked-tool { flex-shrink: 0; font-family: var(--mono); font-size: 13px; font-weight: 600; color: var(--context); }
  .unblocked-query { font-size: 14px; }

  .diff-summary { display: flex; gap: 16px; font-size: 14px; color: var(--text-muted); margin-bottom: 10px; }
  .diff-added { color: var(--green); font-weight: 600; }
  .diff-removed { color: var(--red); font-weight: 600; }
  .diff-block { border: 1px solid var(--rule); background: #fdfbfc; overflow: auto; max-height: 600px; }
  .diff-block pre { padding: 12px 0; font-size: 12.5px; line-height: 1.55; tab-size: 4; }
  .diff-block code { white-space: pre; }
  .diff-file { color: var(--ink); font-weight: 600; background: var(--tint); display: inline-block; width: 100%; padding: 2px 0; }
  .diff-meta { color: var(--text-muted); }
  .diff-hunk { color: var(--context); }
  .diff-add { background: var(--green-tint); display: inline-block; width: 100%; }
  .diff-del { background: var(--red-tint); display: inline-block; width: 100%; }

  .footer { padding-top: 20px; border-top: 1px solid var(--rule); font-size: 13px; color: var(--text-muted); }

  @media (max-width: 760px) {
    .sheet { margin: 0; padding: 0 16px 28px; border-radius: 0; }
    .masthead { margin: 0 -16px 32px; padding: 32px 16px 24px; }
    .hero { margin: 0 -16px 36px; padding: 28px 16px 24px; }
    .hero-meta { margin-bottom: 28px; }
    .hero-task { font-size: 34px; }
    .hero-lede { font-size: 23px; margin: 32px 0 28px; padding-top: 22px; }
    .board { grid-template-columns: 1fr 1fr; row-gap: 28px; }
    .cell:nth-child(3) { padding-left: 0; border-left: none; }
    .cell-fig { font-size: 60px; }
    .cell-fig.word { font-size: 48px; padding-top: 8px; }
    .masthead h1 { font-size: 40px; }
    .fig { font-size: 40px; }
    .facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .lede { font-size: 24px; }
    .results, .results tbody { display: block; }
    .results thead { display: none; }
    .full-report > summary { flex-wrap: wrap; row-gap: 2px; }
    .full-report > summary span { flex-basis: 100%; padding-left: 32px; }
    .results tr { display: grid; grid-template-columns: 1fr 1fr; column-gap: 16px; padding: 14px 0; border-bottom: 1px solid var(--rule); }
    .results th, .results td { display: block; border: none; padding: 0; width: auto !important; }
    .results tbody th { grid-column: 1 / -1; margin-bottom: 6px; }
    .results td:nth-child(4), .quality-row td { grid-column: 1 / -1; }
    .hero-grid, .hero-3, .hero-4 { grid-template-columns: 1fr; }
    .comparison-row { grid-template-columns: 1fr; gap: 6px; }
    .bar-tag { width: 90px; }
    .arm-meta { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media print {
    body { background: #fff; }
    .sheet { box-shadow: none; margin: 0; }
    .seg, .split-total { animation: none; }
  }
`;

export const BATCH_CSS = `
  .results tbody th { width: 190px; }
`;

// Scoreboard figures count up once on load. The final value is in the HTML,
// so the page reads the same without script or with reduced motion.
export const COUNT_UP = `<script>
(() => {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const start = performance.now() + 150;
  document.querySelectorAll("[data-count]").forEach((el, i) => {
    const to = Number(el.dataset.count), t0 = start + i * 120, d = 1100;
    const show = v => { el.textContent = (v < 0 ? "\u2212" : v > 0 ? "+" : "") + Math.abs(v) + "%"; };
    show(0);
    const step = t => {
      const p = Math.min(1, Math.max(0, (t - t0) / d));
      show(Math.round(to * (1 - Math.pow(1 - p, 3))));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
})();
</script>`;
