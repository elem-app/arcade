import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { SemanticText, SemanticTextPart } from "@elem-app/arc/runtime";

import { ORIGINATOR_AUDIENCE } from "../constants.js";

export type PromptAudienceReference = {
  marker: string;
  audience: string;
};

export type RenderedSemanticText = {
  text: string;
  artifactPaths: readonly string[];
  audienceReferences: readonly PromptAudienceReference[];
};

/**
 * Inputs needed to render host-owned semantic text parts.
 *
 * - `workspacePath`: absolute directory where logical artifact paths resolve
 *   unless a bundle prefix matches.
 * - `bundle`: longest-prefix map from logical artifact path prefix to an
 *   absolute directory; matched paths resolve into the bundle directory.
 */
export type RenderContext = {
  workspacePath: string;
  bundle?: Readonly<Record<string, string>>;
};

export type ArtifactPathRenderTarget =
  | { kind: "host" }
  | { kind: "sandbox"; sandboxRoot: string };

/**
 * Sandbox path the Arc workspace is rooted at. The OpenAI SDK backend roots the
 * session here (it is the manifest root, masked to this name), so worker paths
 * read `/workspace/...`. Shared so the renderer, the backend's manifest, and the
 * bundle materializer all agree on the one name.
 */
export const WORKSPACE_SANDBOX_ROOT = "/workspace";

/**
 * Reserved directory under the workspace holding materialized bundle copies.
 *
 * Bundle inputs live outside the Arc workspace on the host, so the OpenAI SDK
 * backend copies them under this dotted prefix inside the workspace. The prefix
 * is shared by the renderer (which projects bundle artifact paths here) and the
 * backend's materializer (which copies the files here); the two must agree.
 */
export const SANDBOX_BUNDLE_ROOT = `${WORKSPACE_SANDBOX_ROOT}/.arcade-bundles`;

/** Splits a bundle logical prefix (e.g. `"methodology/"`) into path segments. */
export function bundlePrefixSegments(prefix: string): string[] {
  return prefix.split("/").filter((segment) => segment !== "");
}

/** Sandbox directory a bundle prefix's contents are materialized and rendered into. */
export function sandboxBundleRoot(prefix: string): string {
  return [SANDBOX_BUNDLE_ROOT, ...bundlePrefixSegments(prefix)].join("/");
}

/** Renders Arc semantic text into the prompt-facing form used by Arcade workers. */
export class SemanticTextRenderer {
  render(text: SemanticText, context: RenderContext): RenderedSemanticText {
    if (typeof text === "string") {
      return { text, artifactPaths: [], audienceReferences: [] };
    }

    const artifactPaths: string[] = [];
    const audienceReferences: PromptAudienceReference[] = [];
    const rendered = text
      .map((part) => {
        if (part.kind === "text") return part.value;
        if (part.kind === "entity") {
          const audience = audienceForEntity(part.name);
          if (audience)
            audienceReferences.push({ marker: part.name, audience });
          return part.name;
        }
        if (part.kind === "hostVar") {
          const marker = markerForHostVar(part);
          const audience = audienceForHostVar(part);
          if (audience) audienceReferences.push({ marker, audience });
          return marker;
        }
        const artifactPath = pathFor(context, part.path);
        artifactPaths.push(artifactPath);
        return artifactPath;
      })
      .join("");

    return {
      text: rendered,
      artifactPaths,
      audienceReferences: uniqueAudienceReferences(audienceReferences),
    };
  }
}

export function renderAgentSemanticText(
  text: SemanticText,
  context: {
    workspacePath: string;
    workspaceBundle: Readonly<Record<string, string>>;
  },
  target: ArtifactPathRenderTarget,
): RenderedSemanticText {
  const rendered = renderSemanticTextParts(text, {
    workspacePath: context.workspacePath,
    bundle: context.workspaceBundle,
  });
  if (target.kind === "host") return rendered;

  return renderSemanticTextParts(text, {
    workspacePath: context.workspacePath,
    bundle: context.workspaceBundle,
    mapPath: (resolved) => {
      // Bundle artifacts are materialized under the reserved bundle prefix
      // inside the workspace; project them there rather than onto the workspace
      // root. The host bundle directory never reaches the model.
      if (resolved.bundlePrefix !== undefined) {
        return projectHostPathToSandbox(resolved.hostPath, {
          hostRoot: resolved.hostRoot,
          sandboxRoot: sandboxBundleRoot(resolved.bundlePrefix),
        });
      }
      return projectHostPathToSandbox(resolved.hostPath, {
        hostRoot: context.workspacePath,
        sandboxRoot: target.sandboxRoot,
      });
    },
  });
}

export function diagnosticSemanticText(text: SemanticText): string {
  if (typeof text === "string") return text;
  return text
    .map((part) => {
      if (part.kind === "text") return part.value;
      if (part.kind === "entity") return part.name;
      if (part.kind === "hostVar")
        return `<${part.module}:${part.path.join(".")}>`;
      return `Artifact(${part.path})`;
    })
    .join("");
}

type ResolvedArtifactPath = {
  hostPath: string;
  hostRoot: string;
  bundlePrefix?: string;
};

function pathFor(context: RenderContext, logicalPath: string): string {
  return resolveArtifactPath(context, logicalPath).hostPath;
}

function resolveArtifactPath(
  context: RenderContext,
  logicalPath: string,
): ResolvedArtifactPath {
  const segments = artifactPathSegments(logicalPath);
  const bundled = resolveBundle(context.bundle, logicalPath);
  if (bundled) {
    return {
      hostPath: join(bundled.base, ...bundled.rest),
      hostRoot: bundled.base,
      bundlePrefix: bundled.prefix,
    };
  }
  return {
    hostPath: join(context.workspacePath, ...segments),
    hostRoot: context.workspacePath,
  };
}

function renderSemanticTextParts(
  text: SemanticText,
  context: RenderContext & {
    mapPath?: (resolved: ResolvedArtifactPath) => string;
  },
): RenderedSemanticText {
  if (typeof text === "string") {
    return { text, artifactPaths: [], audienceReferences: [] };
  }

  const artifactPaths: string[] = [];
  const audienceReferences: PromptAudienceReference[] = [];
  const rendered = text
    .map((part) => {
      if (part.kind === "text") return part.value;
      if (part.kind === "entity") {
        const audience = audienceForEntity(part.name);
        if (audience) audienceReferences.push({ marker: part.name, audience });
        return part.name;
      }
      if (part.kind === "hostVar") {
        const marker = markerForHostVar(part);
        const audience = audienceForHostVar(part);
        if (audience) audienceReferences.push({ marker, audience });
        return marker;
      }
      const resolved = resolveArtifactPath(context, part.path);
      const artifactPath = context.mapPath
        ? context.mapPath(resolved)
        : resolved.hostPath;
      artifactPaths.push(artifactPath);
      return artifactPath;
    })
    .join("");

  return {
    text: rendered,
    artifactPaths,
    audienceReferences: uniqueAudienceReferences(audienceReferences),
  };
}

function audienceForEntity(
  entity: Extract<SemanticTextPart, { kind: "entity" }>["name"],
): string | undefined {
  if (entity === "user") return ORIGINATOR_AUDIENCE;
  return undefined;
}

function markerForHostVar(
  part: Extract<SemanticTextPart, { kind: "hostVar" }>,
) {
  return `<${part.module}:${part.path.join(".")}>`;
}

function audienceForHostVar(
  part: Extract<SemanticTextPart, { kind: "hostVar" }>,
): string | undefined {
  if (part.module !== "audience") return undefined;
  const audience = part.path.join(".").trim();
  return audience.length > 0 ? audience : undefined;
}

function uniqueAudienceReferences(
  refs: readonly PromptAudienceReference[],
): PromptAudienceReference[] {
  const seen = new Set<string>();
  const unique: PromptAudienceReference[] = [];
  for (const ref of refs) {
    if (seen.has(ref.marker)) continue;
    seen.add(ref.marker);
    unique.push(ref);
  }
  return unique;
}

function projectHostPathToSandbox(
  hostPath: string,
  input: { hostRoot: string; sandboxRoot: string },
): string {
  const hostRoot = resolve(input.hostRoot);
  const resolvedHostPath = resolve(hostPath);
  const relativePath = relative(hostRoot, resolvedHostPath);
  if (hostPathEscapesRoot(relativePath)) {
    throw new Error(
      `OpenAI sandbox cannot render artifact outside mounted workspace: ${hostPath}`,
    );
  }
  if (relativePath === "") return input.sandboxRoot;
  return `${input.sandboxRoot}/${relativePath.split(sep).join("/")}`;
}

function resolveBundle(
  bundle: Readonly<Record<string, string>> | undefined,
  logicalPath: string,
): { prefix: string; base: string; rest: string[] } | undefined {
  if (!bundle) return undefined;
  let bestPrefix: string | undefined;
  for (const prefix of Object.keys(bundle)) {
    if (!logicalPath.startsWith(prefix)) continue;
    if (bestPrefix === undefined || prefix.length > bestPrefix.length) {
      bestPrefix = prefix;
    }
  }
  if (bestPrefix === undefined) return undefined;
  const base = bundle[bestPrefix]!;
  const restPath = logicalPath.slice(bestPrefix.length);
  if (restPath === "") return { prefix: bestPrefix, base, rest: [] };
  const rest = restPath.split("/").filter((segment) => segment !== "");
  return { prefix: bestPrefix, base, rest };
}

function artifactPathSegments(path: string): string[] {
  if (path.trim() === "") {
    throw new Error("Arc artifact path must be non-empty.");
  }
  if (path.startsWith("/") || path.includes("\\")) {
    throw new Error(`Arc artifact path must be relative: ${path}`);
  }
  const segments = path.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new Error(`Arc artifact path contains an invalid segment: ${path}`);
  }
  return segments;
}

function hostPathEscapesRoot(relativePath: string): boolean {
  return (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  );
}
