import { isAbsolute } from "node:path";

import { z } from "zod";

const WorkspaceScopeSchema = z.enum(["run", "arc"]);
const ContextIsolationSchema = z.enum(["role", "node"]);
const BundlePathSchema = z
  .string()
  .refine((path) => path.trim() !== "", "Bundle paths must not be empty.");

/** Authored arcade.json fields with defaults, before bundle path resolution. */
export const RawArcManifestSchema = z.object({
  workspace: z
    .object({ scope: WorkspaceScopeSchema.default("run") })
    .default({ scope: "run" }),
  bundle: z.record(z.string(), BundlePathSchema).default({}),
  contextIsolation: ContextIsolationSchema.default("role"),
});

/** Normalized manifest accepted by registration and immutable document records. */
export const ArcManifestSchema = z.object({
  workspaceScope: WorkspaceScopeSchema,
  bundle: z.record(
    z.string(),
    BundlePathSchema.refine(isAbsolute, "Bundle paths must be absolute."),
  ),
  contextIsolation: ContextIsolationSchema,
});

/** Parsed arcade.json fields before discovery resolves bundle paths. */
export type RawArcManifest = z.infer<typeof RawArcManifestSchema>;

/**
 * Normalized Arc manifest resolved at registration.
 *
 * - `workspaceScope: "run"` (default): each new Arc run gets a unique workspace
 *   under the resolved artifact root, named by a filesystem-safe run id.
 * - `workspaceScope: "arc"`: fresh runs use a connector-discovered workspace
 *   path when the Arc was registered from an Arcade workspace, otherwise
 *   activation asks the connecting client for a workspace path through a
 *   handshake.
 * - `bundle`: longest-prefix map from a logical artifact path prefix to an
 *   absolute directory. Matched paths resolve to the bundle directory instead
 *   of the workspace.
 * - `contextIsolation`: run-wide managed-agent context isolation floor.
 */
export type ArcManifest = z.infer<typeof ArcManifestSchema>;

/** Validate and detach a normalized manifest at registration or storage entry. */
export function parseArcManifest(value: unknown): ArcManifest {
  const parsed = ArcManifestSchema.safeParse(value);
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return `${path}${issue.message}`;
  });
  throw new TypeError(`Invalid Arc manifest: ${issues.join("; ")}`);
}
