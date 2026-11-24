import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "vitest";

it("loads and typechecks the built Arcade package as a consumer", async () => {
  const arcade = resolve(import.meta.dirname, "..");
  const consumer = await mkdtemp(join(tmpdir(), "arcade-consumer-"));
  const installed = join(consumer, "node_modules", "arcade");
  const tsc = fileURLToPath(import.meta.resolve("typescript/bin/tsc"));
  try {
    await mkdir(installed, { recursive: true });
    await copyFile(
      join(arcade, "package.json"),
      join(installed, "package.json"),
    );
    await symlink(
      join(arcade, "node_modules"),
      join(installed, "node_modules"),
      "dir",
    );
    await symlink(
      join(arcade, "node_modules", "@types"),
      join(consumer, "node_modules", "@types"),
      "dir",
    );
    await copyFile(
      join(arcade, "__tests__", "fixtures", "package-consumer.mts"),
      join(consumer, "package-consumer.mts"),
    );
    execFileSync(
      process.execPath,
      [tsc, "-p", "tsconfig.build.json", "--outDir", join(installed, "dist")],
      { cwd: arcade, stdio: "inherit" },
    );
    execFileSync(
      process.execPath,
      [
        tsc,
        "--ignoreConfig",
        "--strict",
        "--skipLibCheck",
        "--types",
        "node",
        "--target",
        "es2022",
        "--module",
        "nodenext",
        "package-consumer.mts",
      ],
      { cwd: consumer, stdio: "inherit" },
    );
    execFileSync(process.execPath, ["package-consumer.mjs"], {
      cwd: consumer,
      stdio: "inherit",
    });
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
}, 60_000);
