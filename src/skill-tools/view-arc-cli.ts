import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { embedArcFiles } from "./view-arc.js";

// Usage: view-arc.mjs [--out <page.html>] <file.arc.js>... — writes a copy of
// the Arc viewer with the files embedded and prints its path. Each file's
// source is named by its directory, as Arcade names a source directory. The
// page defaults to the first file's path with `.arc.js` replaced by `.html`.
const USAGE = "usage: view-arc.mjs [--out <page.html>] <file.arc.js>...\n";

const args = process.argv.slice(2);
let out: string | undefined;
const files: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out") out = args[++i];
  else files.push(args[i]!);
}
if (files.length === 0 || (args.includes("--out") && !out)) {
  process.stderr.write(USAGE);
  process.exit(2);
}

const viewerPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "assets",
  "arc-viewer.html",
);
const page = embedArcFiles(
  readFileSync(viewerPath, "utf8"),
  files.map((file) => {
    const path = resolve(file);
    return {
      path: `${basename(dirname(path))}/${basename(path)}`,
      text: readFileSync(path, "utf8"),
    };
  }),
);
const pagePath = resolve(
  out ?? files[0]!.replace(/(\.arc\.js|\.js)?$/, ".html"),
);
writeFileSync(pagePath, page);
process.stdout.write(`${pagePath}\n`);
