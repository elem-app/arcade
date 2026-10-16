#!/usr/bin/env node

// src/skill-tools/view-arc-cli.ts
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// src/skill-tools/view-arc.ts
function embedArcFiles(viewerHtml, files2) {
  const json = JSON.stringify(files2).replaceAll("<", "\\u003c");
  const element = `<script type="application/json" id="arc-files">${json}</script>
`;
  const at = viewerHtml.lastIndexOf("</body>");
  if (at === -1) throw new Error("The viewer page has no </body> tag.");
  return viewerHtml.slice(0, at) + element + viewerHtml.slice(at);
}

// src/skill-tools/view-arc-cli.ts
var USAGE = "usage: view-arc.mjs [--out <page.html>] <file.arc.js>...\n";
var args = process.argv.slice(2);
var out;
var files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out") out = args[++i];
  else files.push(args[i]);
}
if (files.length === 0 || args.includes("--out") && !out) {
  process.stderr.write(USAGE);
  process.exit(2);
}
var viewerPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "assets",
  "arc-viewer.html"
);
var page = embedArcFiles(
  readFileSync(viewerPath, "utf8"),
  files.map((file) => {
    const path = resolve(file);
    return {
      path: `${basename(dirname(path))}/${basename(path)}`,
      text: readFileSync(path, "utf8")
    };
  })
);
var pagePath = resolve(
  out ?? files[0].replace(/(\.arc\.js|\.js)?$/, ".html")
);
writeFileSync(pagePath, page);
process.stdout.write(`${pagePath}
`);
