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

/** Destination used to render a logical artifact for a worker. */
export type ArtifactPathRenderTarget =
  | { kind: "host" }
  | {
      kind: "sandbox";
      sandboxRoot: string;
      /**
       * Return the path the worker should see for a matched bundle.
       * Arcade preserves a terminal `/.` as a trailing slash on the result.
       *
       * @param location - The value of `workspaceBundle[prefix]` for the longest matching prefix, passed verbatim.
       * @param suffix - The relative path left after Arcade removes that prefix, with components joined by `/`.
       * An empty string refers to the mount itself.
       * @example With `{ "assets/": "/outer", "assets/deep/": "/inner" }` as the bundle map,
       * `assets//deep/x` calls `renderBundlePath("/inner", "x")`.
       */
      renderBundlePath?: (location: string, suffix: string) => string;
    };

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
    return renderSemanticTextParts(text, context, { kind: "host" });
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
  return renderSemanticTextParts(
    text,
    {
      workspacePath: context.workspacePath,
      bundle: context.workspaceBundle,
    },
    target,
  );
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

function renderArtifactPath(
  logicalPath: string,
  context: RenderContext,
  target: ArtifactPathRenderTarget,
): string {
  if (logicalPath.startsWith("/") || logicalPath.includes("\\")) {
    throw new Error(`Arc artifact path must be relative: ${logicalPath}`);
  }
  const segments = logicalPath.split("/");
  if (segments.includes("..")) {
    throw new Error(
      `Arc artifact path contains an invalid segment: ${logicalPath}`,
    );
  }
  const relativePath = segments
    .filter((part) => part !== "" && part !== ".")
    .join("/");
  const directory = logicalPath.endsWith("/.");
  const trailingSlash = logicalPath.endsWith("/");
  const lookup = relativePath + (directory || trailingSlash ? "/" : "");
  const match = relativePath
    ? resolveBundle(context.bundle, lookup)
    : undefined;
  if (match && target.kind === "sandbox" && target.renderBundlePath) {
    const path = target.renderBundlePath(match.location, match.suffix);
    return directory && !path.endsWith("/") ? path + "/" : path;
  }
  if (logicalPath.trim() === "")
    throw new Error("Arc artifact path must be non-empty.");
  if (trailingSlash)
    throw new Error(
      `Arc artifact path contains an invalid segment: ${logicalPath}`,
    );
  if (!relativePath)
    return target.kind === "host" ? context.workspacePath : target.sandboxRoot;
  const hostRoot = match?.location ?? context.workspacePath;
  const hostPath = join(
    hostRoot,
    match?.suffix ?? relativePath,
    directory ? sep : "",
  );
  if (target.kind === "host") return hostPath;
  return projectHostPathToSandbox(hostPath, {
    hostRoot,
    sandboxRoot: match ? sandboxBundleRoot(match.prefix) : target.sandboxRoot,
  });
}

function renderSemanticTextParts(
  text: SemanticText,
  context: RenderContext,
  target: ArtifactPathRenderTarget,
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
      const artifactPath = renderArtifactPath(part.path, context, target);
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
  const path = relativePath
    ? `${input.sandboxRoot}/${relativePath.split(sep).join("/")}`
    : input.sandboxRoot;
  return hostPath.endsWith(sep) && !path.endsWith("/") ? path + "/" : path;
}

function resolveBundle(
  bundle: Readonly<Record<string, string>> | undefined,
  logicalPath: string,
) {
  if (!bundle) return undefined;
  let bestPrefix: string | undefined;
  for (const prefix of Object.keys(bundle)) {
    if (!logicalPath.startsWith(prefix)) continue;
    if (bestPrefix === undefined || prefix.length > bestPrefix.length) {
      bestPrefix = prefix;
    }
  }
  if (bestPrefix === undefined) return undefined;
  const parts = logicalPath.slice(bestPrefix.length).split("/").filter(Boolean);
  // Literal prefixes may end inside a component. Check the suffix before any destination joins it.
  if (parts.includes(".."))
    throw new Error(
      `Arc bundle suffix contains a parent component: ${logicalPath}`,
    );
  return {
    prefix: bestPrefix,
    location: bundle[bestPrefix]!,
    suffix: parts.join("/"),
  };
}

function hostPathEscapesRoot(relativePath: string): boolean {
  return (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  );
}
