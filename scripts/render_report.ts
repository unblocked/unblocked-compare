// Re-render report.html from a saved result.json, with no model calls: for a
// report layout or styling change. Pass one or more result directories (each
// holding a result.json); report.html is rewritten beside it.
import fs from "node:fs";
import path from "node:path";
import { writeHtmlReport } from "../src/report.ts";
import type { ComparisonResult } from "../src/types.ts";

const dirs = process.argv.slice(2);
if (!dirs.length) {
  console.error("Usage: bun run render <result-dir> [<result-dir> ...]");
  process.exit(1);
}
for (const dir of dirs) {
  const file = path.join(dir, "result.json");
  if (!fs.existsSync(file)) {
    console.error(`No result.json in ${dir}`);
    process.exitCode = 1;
    continue;
  }
  const result = JSON.parse(fs.readFileSync(file, "utf8")) as ComparisonResult;
  console.log(writeHtmlReport(result, path.resolve(dir)));
}
