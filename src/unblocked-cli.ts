// Recognising an Unblocked CLI call in a shell command: `unblocked
// context-research ...`, possibly after `cd x &&`, and possibly by path (the
// simulated engine's shim is called by its absolute path, since login shells
// reorder PATH).
const CLI = /(?:^|[;&|(]\s*)((?:\S*\/)?)unblocked\s+(context[_-][\w-]+)/;

export interface UnblockedCommand {
  // "context-research", "context_get_urls", ...
  tool: string;
  // The directory prefix it was called by; "" for a bare `unblocked`.
  path: string;
}

// A shell command that publishes outside the working copy: a push, or a GitHub
// write through gh (PRs, issues, comments, reviews, API writes). Agents must
// not do this during a comparison; on ENG-735 one pushed and opened a PR.
// Matched in command position only (start, or after ; & | ( then do), on the
// command with quoted text blanked, so `grep "git push"` or an echo does not
// count. `gh api graphql` is a write only for a mutation; other `gh api` calls
// that send fields default to POST.
const AT = String.raw`(?:^|[;&|(]\s*|\b(?:then|do)\s+)`;
const OUTWARD = [
  new RegExp(AT + String.raw`git\s+push\b`),
  new RegExp(AT + String.raw`gh\s+(?:pr|issue|release|repo)\s+(?:create|merge|close|edit|comment|review|reopen|ready|delete|fork)\b`),
  new RegExp(AT + String.raw`gh\s+api\b[^|;&]*(?:-X|--method)\s*(?:POST|PATCH|PUT|DELETE)\b`, "i"),
  new RegExp(AT + String.raw`gh\s+api\s+(?!graphql\b)(?![^|;&]*(?:-X|--method)\s*GET\b)[^|;&]*\s(?:-f|-F|--field|--raw-field|--input)\s`),
];
const GRAPHQL = new RegExp(AT + String.raw`gh\s+api\s+graphql\b`);

function blankQuotes(command: string): string {
  return command.replace(/'[^']*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""');
}

export function outwardAction(command: string): string | null {
  const bare = blankQuotes(command);
  for (const re of OUTWARD) {
    const m = bare.match(re);
    if (m) return m[0].replace(/^[;&|(\s]+|^(?:then|do)\s+/, "").trim();
  }
  if (GRAPHQL.test(bare) && /\bmutation\b/.test(command)) return "gh api graphql mutation";
  return null;
}

export function unblockedCommand(command: string): UnblockedCommand | null {
  const m = command.match(CLI);
  return m ? { tool: m[2], path: m[1] } : null;
}
