// Report styling: a light sheet under a deep navy hero. Green is better and
// red is worse, nowhere else; cobalt is the context arm, cool grey the Baseline.
// Bricolage Grotesque for display, Atkinson Hyperlegible for reading.
export const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Mono:wght@400;600&family=Bricolage+Grotesque:opsz,wght@12..96,500..800&family=Atkinson+Hyperlegible+Next:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap">`;

export const REPORT_CSS = `
  :root {
    --ground: #edf0f5;
    --paper: #ffffff;
    --ink: #172033;
    --text: #172033;
    --text-muted: #5d6678;
    --rule: #dde2ea;
    --rule-soft: #eceff4;
    --tint: #f5f7fa;
    --context: #2f5bd8;
    --context-tint: #e9effc;
    --baseline: #8a93a6;
    --better: #16833f;
    --worse: #c42b2b;
    --green: #16833f;
    --green-tint: #e5f4e9;
    --red: #c42b2b;
    --red-tint: #fbe9e7;
    --yellow: #94640a;
    --band: #0c1630;
    --band-ink: #eef3fc;
    --band-muted: rgba(238, 243, 252, 0.62);
    --band-rule: rgba(238, 243, 252, 0.16);
    --band-better: #7fe0a0;
    --band-worse: #ff8a80;
    --band-label: #9fb8ee;
    --display: "Bricolage Grotesque", "Atkinson Hyperlegible Next", system-ui, sans-serif;
    --sans: "Atkinson Hyperlegible Next", system-ui, -apple-system, "Segoe UI", sans-serif;
    --mono: "Atkinson Hyperlegible Mono", ui-monospace, "SF Mono", Menlo, monospace;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: var(--sans); background: var(--ground); color: var(--ink); font-size: 15px; line-height: 1.55; font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased; }
  code, pre { font-family: var(--mono); }
  a { color: var(--context); text-underline-offset: 2px; }
  :focus-visible { outline: 2px solid var(--context); outline-offset: 2px; }

  body { background: radial-gradient(1200px 640px at 50% -220px, #d4def2, transparent 70%), var(--ground); }
  .sheet { max-width: 1000px; margin: 40px auto 64px; padding: 0 64px 44px; background: var(--paper); border-radius: 14px; overflow: hidden; box-shadow: 0 1px 0 rgba(12, 22, 48, 0.06), 0 50px 100px -40px rgba(12, 22, 48, 0.5); }

  .masthead { margin: 0 -64px 44px; padding: 52px 64px 36px; background: var(--band); color: var(--band-ink); }
  .product { font-size: 14px; color: var(--band-label); margin-bottom: 10px; }
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
  .hero { position: relative; margin: 0 -64px 52px; padding: 40px 64px 34px; color: var(--band-ink); background: radial-gradient(900px 420px at 100% 0%, rgba(47, 91, 216, 0.55), transparent 65%), var(--band); }
  .hero-meta { display: flex; justify-content: space-between; font-size: 13px; color: var(--band-muted); margin-bottom: 44px; }
  .hero-meta span:first-child { color: var(--band-label); font-weight: 600; }
  .hero-vs { font-size: 15px; color: var(--band-label); margin-bottom: 8px; }
  .hero-task { font-family: var(--display); font-size: 46px; line-height: 1.02; font-weight: 800; letter-spacing: -0.035em; font-variation-settings: "opsz" 96; max-width: 22ch; margin-bottom: 14px; text-wrap: balance; }
  .hero-task-rest { font-size: 15px; line-height: 1.6; color: var(--band-muted); max-width: 70ch; white-space: pre-wrap; overflow-wrap: anywhere; }
  .hero-lede { font-family: var(--display); font-size: 30px; line-height: 1.2; font-weight: 500; letter-spacing: -0.02em; max-width: 34ch; margin: 48px 0 40px; padding-top: 28px; border-top: 1px solid var(--band-rule); text-wrap: balance; }
  .board { display: grid; grid-template-columns: 1.15fr 1fr 1fr 1fr; margin-bottom: 40px; }
  .cell { min-width: 0; padding: 0 18px; border-left: 1px solid var(--band-rule); }
  .cell:first-child { padding-left: 0; border-left: none; }
  .cell-label { font-size: 14px; color: var(--band-muted); margin-bottom: 6px; }
  .cell-fig { font-family: var(--display); font-size: 74px; line-height: 0.95; font-weight: 800; letter-spacing: -0.05em; font-variation-settings: "opsz" 96; color: var(--band-ink); margin-bottom: 14px; font-variant-numeric: tabular-nums; }
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
  .fig.measured.better { color: #4f9a67; }
  .fig.measured.worse { color: #d4605a; }
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
  /* Green shades pull the difference down, red shades push it up;
     strongest for the context's influence, lightest for other work. */
  .split-neg .seg-influence, .key-influence.down { background: #16833f; }
  .split-neg .seg-own, .key-own.down { background: #62b07c; }
  .split-neg .seg-other, .key-other.down { background: #b9ddc4; }
  .split-pos .seg-influence, .key-influence.up { background: #c42b2b; }
  .split-pos .seg-own, .key-own.up { background: #e2726b; }
  .split-pos .seg-other, .key-other.up { background: #f3c3be; }
  .split-zero { position: absolute; left: 50%; top: -4px; bottom: -4px; width: 1px; background: var(--ink); }
  .split-total { position: absolute; top: -7px; bottom: -7px; width: 3px; margin-left: -1px; background: var(--ink); border-radius: 2px; }
  .split-text { font-size: 13px; color: var(--text-muted); line-height: 1.6; }
  .split-text span { white-space: nowrap; margin-right: 10px; }
  .key { display: inline-block; width: 9px; height: 9px; margin: 0 5px 0 0; vertical-align: 0; font-style: normal; }

  /* Arm bars: one per arm, shared scale */
  .armbars { display: flex; flex-direction: column; gap: 8px; padding-top: 4px; }
  .ab-row { display: grid; grid-template-columns: 118px 1fr; align-items: center; gap: 10px; }
  .ab-name { font-size: 13px; color: var(--text-muted); }
  .ab-row + .ab-row .ab-name { color: var(--context); font-weight: 600; }
  .ab-track { display: flex; align-items: center; height: 26px; }
  .ab-seg { height: 100%; display: flex; align-items: center; justify-content: center; overflow: hidden; white-space: nowrap; font-size: 12px; font-weight: 600; animation: grow 0.9s cubic-bezier(0.2, 0.8, 0.2, 1) both; transform-origin: left center; }
  .ab-seg:first-child { border-radius: 4px 0 0 4px; }
  .ab-track .ab-seg:nth-last-child(2) { border-radius: 0 4px 4px 0; }
  .ab-track .ab-seg:only-of-type { border-radius: 4px; }
  .ab-other { background: #d3d9e3; color: var(--ink); }
  .ab-context { background: var(--context); color: #fff; }
  .ab-own { background: #d9463f; color: #fff; }
  .ab-row + .ab-row .ab-seg { animation-delay: 0.1s; }
  .ab-total { padding-left: 10px; font-size: 13px; font-weight: 700; white-space: nowrap; }
  .ab-legend { display: flex; flex-wrap: wrap; gap: 6px 20px; font-size: 13px; color: var(--text-muted); margin: -8px 0 8px; }
  .ab-key { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; }
  @media (prefers-reduced-motion: reduce) { .ab-seg { animation: none; } }

  /* Without vs with: plain bars and what made the difference */
  .cmps { display: flex; flex-direction: column; margin-bottom: 20px; border-top: 2px solid var(--ink); }
  .cmp { display: grid; grid-template-columns: 90px 1fr 250px; gap: 24px; align-items: center; padding: 22px 0; border-bottom: 1px solid var(--rule); }
  .cmp-label { font-family: var(--display); font-size: 20px; font-weight: 700; letter-spacing: -0.01em; }
  .cmp-bars { display: flex; flex-direction: column; gap: 8px; }
  .cb-row { display: grid; grid-template-columns: 150px 1fr; align-items: center; gap: 12px; }
  .cb-name { font-size: 13px; color: var(--text-muted); }
  .cb-name.ctx { color: var(--context); font-weight: 600; }
  .cb-track { display: flex; align-items: center; height: 24px; }
  .cb-val { margin-left: 10px; }
  .cb-bar { height: 100%; border-radius: 4px; animation: grow 0.9s cubic-bezier(0.2, 0.8, 0.2, 1) both; transform-origin: left center; }
  .cb-bar.base { background: #c9d0dc; }
  .cb-track .cb-bar.base:not(:only-of-type) { border-radius: 4px 0 0 4px; }
  .cb-bar.saved, .cb-bar.added { display: flex; align-items: center; padding: 0 8px; border-radius: 0 4px 4px 0; overflow: hidden; white-space: nowrap; font-size: 12px; font-weight: 700; }
  .cb-bar.saved { background: repeating-linear-gradient(-45deg, #d6efdc 0 6px, #c3e6cc 6px 12px); color: var(--better); box-shadow: inset 0 0 0 1.5px var(--better); }
  .cb-bar.added { background: repeating-linear-gradient(-45deg, #f8dcd9 0 6px, #f1c9c5 6px 12px); color: var(--worse); box-shadow: inset 0 0 0 1.5px var(--worse); }
  .cb-bar.ctx { background: var(--context); animation-delay: 0.1s; }
  .cb-val { font-size: 14px; font-weight: 700; white-space: nowrap; }
  .cb-val em { font-style: normal; margin-left: 4px; }
  .cb-val em.better { color: var(--better); }
  .cb-val em.worse { color: var(--worse); }
  .why { list-style: none; display: flex; flex-direction: column; gap: 6px; font-size: 14px; line-height: 1.35; }
  .why li { position: relative; padding-left: 18px; }
  .why li::before { content: ""; position: absolute; left: 0; top: 0.42em; width: 9px; height: 9px; border-radius: 50%; }
  .why li.good::before { background: var(--better); }
  .why li.bad::before { background: var(--worse); }
  @media (prefers-reduced-motion: reduce) { .cb-bar { animation: none; } }

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
  .bar-fill.baseline { background: #e3e7ee; color: var(--ink); }
  .bar-fill.better { background: var(--context-tint); color: var(--better); box-shadow: inset 3px 0 0 var(--context); }
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
  .diff-block { border: 1px solid var(--rule); background: #fbfcfd; overflow: auto; max-height: 600px; }
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
    .results td:nth-child(4), .quality-row td { grid-column: 1 / -1; margin-top: 12px; }
    .ab-row { grid-template-columns: 1fr; gap: 2px; }
    .cmp { grid-template-columns: 1fr; gap: 12px; }
    .cb-row { grid-template-columns: 1fr; gap: 2px; }
    .hero-grid, .hero-3, .hero-4 { grid-template-columns: 1fr; }
    .comparison-row { grid-template-columns: 1fr; gap: 6px; }
    .bar-tag { width: 90px; }
    .arm-meta { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  @media print {
    body { background: #fff; }
    .sheet { box-shadow: none; margin: 0; }
    .seg, .split-total, .ab-seg, .cb-bar { animation: none; }
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
