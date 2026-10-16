import { analyzeDocument, parse } from "@elem-app/arc/parser";
import type { Node } from "@elem-app/arc/types";

import { builtInHostModuleDeclarations } from "../service/host-module-declarations.js";

/** What checking one Arc source found, formatted for a terminal. */
export type ArcCheckReport = {
  /** False when the source fails to parse or has a validation issue. */
  ok: boolean;
  lines: string[];
};

/**
 * Checks Arc source the way Arcade loads it: parses it, then analyzes it
 * against the host modules every Arcade registers. Lists validation issues,
 * lints, and an outline of the nodes, marking those with no action graph yet
 * as empty.
 */
export function checkArcSource(source: string): ArcCheckReport {
  let document;
  try {
    document = parse(source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, lines: [`parse error: ${message}`] };
  }

  const analysis = analyzeDocument(document, {
    hostModules: builtInHostModuleDeclarations,
  });
  const lines: string[] = [];
  for (const issue of analysis.issues) {
    lines.push(`error ${issue.code} ${position(issue.loc)}${issue.message}`);
  }
  for (const lint of analysis.lintIssues) {
    lines.push(
      `${lint.severity} ${lint.code} ${position(lint.loc)}${lint.message}`,
    );
  }
  if (lines.length === 0) lines.push("no issues or lints");
  lines.push("", "outline:");
  for (const root of document.roots) lines.push(...outline(root, 1));
  return { ok: analysis.issues.length === 0, lines };
}

function position(
  loc: { start: { line: number; column: number } } | undefined,
): string {
  return loc ? `${loc.start.line}:${loc.start.column} ` : "";
}

function outline(node: Node, depth: number): string[] {
  const parts = [node.identifier];
  if (node.displayName) parts.push(JSON.stringify(node.displayName));
  const args = Object.keys(node.signature?.args ?? {});
  const returns = Object.keys(node.signature?.returns ?? {});
  if (args.length > 0) parts.push(`args(${args.join(", ")})`);
  if (returns.length > 0) parts.push(`returns(${returns.join(", ")})`);
  if (node.statements.length === 0) parts.push("[empty]");
  return [
    `${"  ".repeat(depth)}${parts.join(" ")}`,
    ...node.children.flatMap((child) => outline(child, depth + 1)),
  ];
}
