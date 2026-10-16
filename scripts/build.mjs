import { spawn } from "node:child_process";
import { chmod, copyFile, cp, readdir, rm } from "node:fs/promises";

import { build } from "esbuild";

// Skills are assembled independently and may be shipped prebuilt.
const outputs = await readdir("dist").catch((error) => {
  if (error.code === "ENOENT") return [];
  throw error;
});
for (const output of outputs) {
  if (output !== "skills") {
    await rm(`dist/${output}`, { recursive: true, force: true });
  }
}

await run(process.execPath, ["node_modules/vite/bin/vite.js", "build"], {
  cwd: "web",
});
await run(process.execPath, [
  "node_modules/typescript/bin/tsc",
  "-p",
  "tsconfig.build.json",
]);

const external = [
  "@anthropic-ai/claude-agent-sdk",
  "@anthropic-ai/claude-agent-sdk/*",
  "@anthropic-ai/claude-agent-sdk-darwin-arm64",
  "@anthropic-ai/claude-agent-sdk-darwin-x64",
  "@anthropic-ai/claude-agent-sdk-linux-arm64",
  "@anthropic-ai/claude-agent-sdk-linux-arm64-musl",
  "@anthropic-ai/claude-agent-sdk-linux-x64",
  "@anthropic-ai/claude-agent-sdk-linux-x64-musl",
  "@anthropic-ai/claude-agent-sdk-win32-arm64",
  "@anthropic-ai/claude-agent-sdk-win32-x64",
  "@anthropic-ai/sdk",
  "@anthropic-ai/sdk/*",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-agent-core/*",
  "@modelcontextprotocol/sdk",
  "@modelcontextprotocol/sdk/*",
  "@openai/agents",
  "@openai/agents/*",
  "@openai/agents-core",
  "@openai/agents-core/*",
  "@openai/agents-openai",
  "@openai/agents-openai/*",
  "@openai/agents-realtime",
  "@openai/agents-realtime/*",
  "openai",
  "openai/*",
  "zod",
];

const executableBuild = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  mainFields: ["module", "main"],
  sourcemap: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
  external,
};

await build({
  ...executableBuild,
  entryPoints: ["src/main.ts"],
  outfile: "dist/app.js",
});

await build({
  ...executableBuild,
  entryPoints: ["eval/main.ts"],
  outfile: "dist/eval-main.js",
});

await chmod("dist/app.js", 0o755);
await chmod("dist/eval-main.js", 0o755);

await cp("web/dist", "dist/web", { recursive: true });

// Ship the local-machine config template next to the binary so `app.ts`
// has a concrete config file to load when ARCADE_CONFIG_FILE is not set.
await copyFile("config.local.jsonc", "dist/config.local.jsonc");

async function run(command, args, options = {}) {
  await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.once("error", rejectRun);
    child.once("exit", (code) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(new Error(`${command} ${args.join(" ")} exited with ${code}`));
    });
  });
}
