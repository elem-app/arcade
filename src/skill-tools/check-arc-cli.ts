import { readFileSync } from "node:fs";

import { checkArcSource } from "./check-arc.js";

// Usage: check-arc.mjs <file.arc.js>... — exits 1 when any file fails.
const files = process.argv.slice(2);
if (files.length === 0) {
  process.stderr.write("usage: check-arc.mjs <file.arc.js>...\n");
  process.exit(2);
}

let ok = true;
for (const file of files) {
  const report = checkArcSource(readFileSync(file, "utf8"));
  ok &&= report.ok;
  process.stdout.write(`${file}\n${report.lines.join("\n")}\n\n`);
}
process.exit(ok ? 0 : 1);
