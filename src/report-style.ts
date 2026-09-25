// Report styling: a light results sheet in one typeface. The context arm is
// teal and the Baseline slate throughout; green and red mean better and worse,
// and appear nowhere else.
export const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible+Mono:wght@400;600&family=Atkinson+Hyperlegible+Next:ital,wght@0,400;0,500;0,600;0,700;1,400&display=swap">`;

export const REPORT_CSS = `
  :root {
    --ground: #e9ecf0;
    --paper: #ffffff;
    --ink: #1a2230;
    --text: #1a2230;
    --text-muted: #5b6577;
    --rule: #d6dbe2;
    --rule-soft: #eaedf1;
    --tint: #f5f7f9;
    --context: #0e6e6a;
    --context-tint: #e5f2f1;
    --baseline: #7d8797;
    --green: #1d7a45;
    --green-tint: #e3f2e8;
    --red: #b3372f;
    --red-tint: #f8e6e4;
    --yellow: #94640a;
    --sans: "Atkinson Hyperlegible Next", system-ui, -apple-system, "Segoe UI", sans-serif;
    --mono: "Atkinson Hyperlegible Mono", ui-monospace, "SF Mono", Menlo, monospace;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: var(--sans); background: var(--ground); color: var(--ink); font-size: 15px; line-height: 1.55; font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased; }
  code, pre { font-family: var(--mono); }
  a { color: var(--context); text-underline-offset: 2px; }
  :focus-visible { outline: 2px solid var(--context); outline-offset: 2px; }

  .sheet { max-width: 960px; margin: 32px auto; padding: 48px 56px 40px; background: var(--paper); border: 1px solid var(--rule); }

  .masthead { padding-bottom: 28px; margin-bottom: 36px; border-bottom: 2px solid var(--ink); }
  .product { font-size: 14px; color: var(--text-muted); margin-bottom: 6px; }
  .masthead h1 { font-size: 38px; line-height: 1.1; font-weight: 700; letter-spacing: -0.01em; margin-bottom: 24px; }
  .facts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px 24px; }
  .facts dt { font-size: 13px; color: var(--text-muted); }
  .facts dd { font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }

  .section { margin-bottom: 44px; }
  .section-title { font-size: 22px; font-weight: 700; line-height: 1.25; margin-bottom: 14px; }
  .section-sub { font-size: 14px; font-weight: 400; color: var(--text-muted); margin-left: 8px; }
  .section-note { font-size: 14px; color: var(--text-muted); margin: 0 0 16px; max-width: 72ch; }
  .task { font-size: 16px; line-height: 1.65; max-width: 72ch; padding: 2px 0 2px 18px; border-left: 3px solid var(--context); white-space: pre-wrap; overflow-wrap: anywhere; }

  /* Summary */
  .lede { font-size: 22px; line-height: 1.4; font-weight: 500; max-width: 40ch; margin-bottom: 24px; }
  .results { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
  .results th, .results td { text-align: left; vertical-align: top; padding: 16px 16px 16px 0; border-bottom: 1px solid var(--rule); }
  .results thead th { font-size: 13px; font-weight: 600; color: var(--text-muted); padding-top: 0; padding-bottom: 8px; border-bottom: 2px solid var(--ink); }
  .results tbody th { font-size: 17px; font-weight: 700; width: 110px; }
  .results td:nth-child(2), .results td:nth-child(3) { width: 150px; }
  .fig { display: block; font-size: 30px; font-weight: 700; line-height: 1.1; letter-spacing: -0.01em; }
  .fig.better { color: var(--green); }
  .fig.worse { color: var(--red); }
  .fig.measured { font-size: 22px; font-weight: 500; color: var(--text-muted); padding-top: 6px; }
  .range { display: block; font-size: 13px; color: var(--text-muted); margin-top: 4px; }
  .quality-row .fig { font-size: 26px; }
  .quality-row .range { font-size: 14px; }

  .split { position: relative; display: flex; height: 18px; margin: 8px 0 10px; background: var(--tint); }
  .split-neg, .split-pos { width: 50%; display: flex; }
  .split-neg { flex-direction: row-reverse; }
  .seg { display: block; height: 100%; }
  .seg-influence, .key-influence { background: var(--context); }
  .seg-own, .key-own { background: var(--baseline); }
  .seg-other, .key-other { background: #c3cad4; }
  .split-zero { position: absolute; left: 50%; top: -4px; bottom: -4px; width: 1px; background: var(--ink); }
  .split-total { position: absolute; top: -6px; bottom: -6px; width: 3px; margin-left: -1px; background: var(--ink); }
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
  .full-report > summary { list-style: none; display: flex; align-items: baseline; gap: 14px; padding: 16px 0; font-size: 20px; font-weight: 700; }
  .full-report > summary::-webkit-details-marker { display: none; }
  .full-report > summary::before { content: "+"; display: inline-block; width: 18px; font-weight: 400; color: var(--context); }
  .full-report[open] > summary::before { content: "\\2212"; }
  .full-report > summary span { font-size: 14px; font-weight: 400; color: var(--text-muted); }
  .full-report[open] > summary { margin-bottom: 28px; border-bottom: 1px solid var(--rule); }

  /* Stat blocks (reports without a Summary) */
  .hero-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 24px; margin-bottom: 36px; }
  .hero-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .hero-4 { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .hero-card { border-top: 2px solid var(--ink); padding-top: 10px; }
  .hero-label { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
  .hero-value { font-size: 30px; font-weight: 700; line-height: 1.15; }
  .hero-value.positive { color: var(--green); }
  .hero-value.negative { color: var(--red); }
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
  .bar-fill.baseline { background: #dfe3e9; color: var(--ink); }
  .bar-fill.better { background: var(--context-tint); color: var(--context); box-shadow: inset 3px 0 0 var(--context); }
  .bar-fill.worse { background: var(--context-tint); color: var(--red); box-shadow: inset 3px 0 0 var(--context); }

  /* Arm details */
  .arm-section { border: 1px solid var(--rule); margin-bottom: 20px; }
  .arm-section.context-arm { border-left: 3px solid var(--context); }
  .arm-header { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; flex-wrap: wrap; padding: 12px 16px; border-bottom: 1px solid var(--rule); background: var(--tint); }
  .arm-name { font-size: 16px; font-weight: 700; }
  .arm-meta { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .arm-stat { padding: 14px 16px; border-right: 1px solid var(--rule-soft); }
  .arm-stat:last-child { border-right: none; }
  .arm-stat-val { font-size: 20px; font-weight: 700; }
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
  .tool-table td:first-child { white-space: nowrap; }
  .highlight-row td { background: var(--context-tint); }
  .highlight-row td:first-child { box-shadow: inset 3px 0 0 var(--context); padding-left: 8px; }

  .met { font-weight: 600; font-size: 13px; }
  .met-met { color: var(--green); } .met-partial { color: var(--yellow); } .met-unmet { color: var(--red); }
  .score { font-weight: 700; }
  .evidence { font-size: 13px; color: var(--text-muted); margin-top: 3px; line-height: 1.5; }

  .verdict { border-left: 3px solid var(--baseline); padding: 4px 0 4px 16px; margin-bottom: 20px; font-size: 15px; max-width: 80ch; }
  .verdict.positive { border-left-color: var(--green); }
  .verdict.negative { border-left-color: var(--red); }
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
    .sheet { margin: 0; padding: 28px 16px; border: none; }
    .masthead h1 { font-size: 30px; }
    .facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .lede { font-size: 19px; }
    .results, .results tbody { display: block; }
    .results thead { display: none; }
    .full-report > summary { flex-wrap: wrap; row-gap: 2px; }
    .full-report > summary span { flex-basis: 100%; padding-left: 32px; }
    .split-text span { white-space: normal; }
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
    .sheet { border: none; margin: 0; padding: 0; }
  }
`;

export const BATCH_CSS = `
  .results tbody th { width: 190px; }
`;
