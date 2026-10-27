import type { Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { parse } from "@elem-app/arc/parser";
import type { Document } from "@elem-app/arc/types";

import {
  RawArcManifestSchema,
  type ArcManifest,
  type RawArcManifest,
} from "../types/manifest.js";
import type { ArcHostService, ArcRegistrationInput } from "./arc-host.js";

// Temporarily inactive while workspace discovery checks explicit roots only.
/*
const IGNORED_WORKSPACE_SCAN_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".arcade-data",
  ".arcade-artifacts",
  ".arcade-diagnostics",
  ".arcademachine-data",
  ".eval-results",
  ".cache",
]);
*/

/** One Arc discovered under the configured arcs directory. */
type DiscoveredArc = {
  /** Source name used by Arc imports; equals the subdirectory name. */
  source: string;
  /** Absolute path to the discovered arc subdirectory. */
  directory: string;
  /** Parsed Arc document. */
  document: Document;
  /** Normalized Arc manifest with absolute bundle paths. */
  manifest: ArcManifest;
};

type ArcRegistrationHost = Pick<ArcHostService, "registerArc" | "registerArcs">;

/** Service for discovering Arc bundles before registering them with the host. */
export class DiscoveryService {
  readonly #arcHost: ArcRegistrationHost;

  constructor(opts: { arcHost: ArcRegistrationHost }) {
    this.#arcHost = opts.arcHost;
  }

  /**
   * Discover Arcade workspaces at one or more absolute working roots.
   *
   * A working root is a workspace when its configured relative `arcsDir` exists
   * as a directory. Only explicitly supplied working roots are inspected.
   */
  async discoverArcadeWorkspaces(
    workingRoots: string | readonly string[],
    arcsDir: string,
  ): Promise<string[]> {
    if (isAbsolute(arcsDir)) {
      throw new Error(
        `Arcade workspace discovery requires a relative arcsDir. Got ${JSON.stringify(arcsDir)}.`,
      );
    }
    const roots =
      typeof workingRoots === "string" ? [workingRoots] : [...workingRoots];
    const discovered = new Set<string>();
    for (const root of roots) {
      if (!isAbsolute(root)) {
        throw new Error(
          `Arcade workspace discovery requires absolute working roots. Got ${JSON.stringify(root)}.`,
        );
      }
      await scanWorkspaceRoot(resolve(root), arcsDir, discovered);
    }
    return [...discovered];
  }

  /** Discover and register Arc bundles from one filesystem directory. */
  async registerArcsFromDirectory(arcsDir: string): Promise<number> {
    const discovered = await discoverArcs(arcsDir);
    if (discovered.length > 0) {
      await this.#arcHost.registerArcs(registrationBatch(discovered));
    }
    return discovered.length;
  }

  /**
   * Discover one named bundle and install it as the latest version of its Arc
   * source. Other bundles are not rescanned; existing runs keep their immutable
   * snapshots while future activations use this version.
   */
  async upsertArcFromDirectory(arcsDir: string, source: string): Promise<void> {
    if (
      source.length === 0 ||
      source === "." ||
      source === ".." ||
      source.includes("/") ||
      source.includes("\\")
    ) {
      throw new Error(
        `Invalid Arc source directory name: ${JSON.stringify(source)}`,
      );
    }
    const root = resolve(arcsDir);
    const arc = await discoverArcDir(source, join(root, source));
    await this.#arcHost.registerArc(arc.source, arc.document, arc.manifest, {
      replace: true,
    });
  }

  /** Discover and register Arc bundles from one Arcade workspace. */
  async registerArcsFromWorkspace(
    workspacePath: string,
    arcsDir: string,
  ): Promise<number> {
    const discovered = await discoverArcs(resolve(workspacePath, arcsDir));
    if (discovered.length > 0) {
      await this.#arcHost.registerArcs(
        registrationBatch(discovered, workspacePath),
      );
    }
    return discovered.length;
  }
}

function registrationBatch(
  discovered: readonly DiscoveredArc[],
  workspacePath?: string,
): ArcRegistrationInput[] {
  return discovered.map((arc) => ({
    source: arc.source,
    document: arc.document,
    manifest: arc.manifest,
    ...(workspacePath === undefined ? {} : { workspacePath }),
  }));
}

/**
 * Walk each immediate subdirectory of `arcsDir`. Each subdirectory becomes one
 * Arc source identified by its directory name. The subdirectory must contain
 * exactly one `*.arc.js` file; an optional `arcade.json` manifest configures
 * workspace scope, context isolation, and the bundle map.
 *
 * Throws if a subdirectory has an invalid manifest, no Arc file, or duplicates
 * a previously discovered source name.
 */
async function discoverArcs(arcsDir: string): Promise<DiscoveredArc[]> {
  const root = resolve(arcsDir);
  const entries = await readDirectoryEntries(root);
  if (!entries) return [];
  const results: DiscoveredArc[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const source = entry.name;
    if (seen.has(source)) {
      throw new Error(`Duplicate Arc source discovered: ${source}`);
    }
    seen.add(source);
    const subdir = join(root, source);
    const arc = await discoverArcDir(source, subdir);
    results.push(arc);
  }
  return results;
}

async function discoverArcDir(
  source: string,
  directory: string,
): Promise<DiscoveredArc> {
  const manifest = await readManifest(source, directory);
  const arcFile = await findSingleArcFile(source, directory);
  const sourceText = await readFile(arcFile, "utf8");
  const document = parse(sourceText);
  return { source, directory, document, manifest };
}

async function scanWorkspaceRoot(
  directory: string,
  arcsDir: string,
  discovered: Set<string>,
): Promise<void> {
  // Descendant traversal is temporarily disabled; retain it for re-enablement.
  // const entries = await readDirectoryEntries(directory);
  // if (!entries) return;
  if (await directoryExists(join(directory, arcsDir)))
    discovered.add(directory);

  /*
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (IGNORED_WORKSPACE_SCAN_DIRS.has(entry.name)) continue;
    await scanWorkspaceRoot(join(directory, entry.name), arcsDir, discovered);
  }
  */
}

async function readDirectoryEntries(
  directory: string,
): Promise<Dirent[] | undefined> {
  if (!(await directoryExists(directory))) return undefined;
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundError(error)) return undefined;
    throw error;
  }
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    const stats = await stat(directory);
    return stats.isDirectory();
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

async function readManifest(
  source: string,
  directory: string,
): Promise<ArcManifest> {
  const manifestPath = join(directory, "arcade.json");
  let raw = "{}";
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  let manifest: RawArcManifest;
  try {
    manifest = RawArcManifestSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `Invalid arcade.json for ${source}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const bundle = await readBundle(source, directory, manifest.bundle);
  return {
    workspaceScope: manifest.workspace.scope,
    bundle,
    contextIsolation: manifest.contextIsolation,
  };
}

async function readBundle(
  source: string,
  directory: string,
  raw: Record<string, string>,
): Promise<Record<string, string>> {
  const bundle: Record<string, string> = {};
  for (const [prefix, value] of Object.entries(raw)) {
    const resolved = isAbsolute(value) ? value : resolve(directory, value);
    if (!(await directoryExists(resolved))) {
      throw new Error(
        `Invalid bundle entry for prefix ${prefix} in arcade.json for ${source}: ${resolved} is not an existing directory.`,
      );
    }
    bundle[prefix] = resolved;
  }
  return bundle;
}

async function findSingleArcFile(
  source: string,
  directory: string,
): Promise<string> {
  const entries = await readdir(directory);
  const arcFiles = entries.filter((name) => name.endsWith(".arc.js"));
  if (arcFiles.length === 0) {
    throw new Error(
      `Arc source ${source} has no *.arc.js file in ${directory}.`,
    );
  }
  if (arcFiles.length > 1) {
    throw new Error(
      `Arc source ${source} has multiple *.arc.js files in ${directory}: ${arcFiles.join(", ")}`,
    );
  }
  const candidate = join(directory, arcFiles[0]!);
  const stats = await stat(candidate);
  if (!stats.isFile()) {
    throw new Error(`Arc source ${source}: ${candidate} is not a file.`);
  }
  return candidate;
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ENOENT"
  );
}
