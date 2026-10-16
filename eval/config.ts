import { resolve } from "node:path";

import {
  EVAL_PROFILES,
  EVAL_TARGET_NAMES,
  type EvalInvocation,
  type EvalProfile,
  type EvalTargetName,
} from "./types.js";

export function parseEvalInvocation(
  argv: readonly string[],
  cwd = process.cwd(),
): EvalInvocation {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  const valueFlags = new Set([
    "targets",
    "profile",
    "cases",
    "repetitions",
    "output",
  ]);
  const switchFlags = new Set(["keep", "debug", "dry-run"]);

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith("--")) {
      throw new Error(
        `Unexpected positional argument ${JSON.stringify(token)}.`,
      );
    }
    const separator = token.indexOf("=");
    const name = token.slice(2, separator === -1 ? undefined : separator);
    if (switchFlags.has(name)) {
      if (separator !== -1) {
        throw new Error(`Flag --${name} does not accept a value.`);
      }
      switches.add(name);
      continue;
    }
    if (!valueFlags.has(name)) {
      throw new Error(`Unknown eval flag --${name}.`);
    }
    const value =
      separator === -1 ? argv[(index += 1)] : token.slice(separator + 1);
    if (!value || value.startsWith("--")) {
      throw new Error(`Flag --${name} requires a value.`);
    }
    if (values.has(name)) {
      throw new Error(`Flag --${name} was provided more than once.`);
    }
    values.set(name, value);
  }

  const targets = parseTargets(values.get("targets") ?? "all");
  const profile = values.has("profile")
    ? parseProfile(values.get("profile")!)
    : undefined;
  const repetitionsText = values.get("repetitions") ?? "1";
  const repetitions = Number(repetitionsText);
  if (!Number.isSafeInteger(repetitions) || repetitions < 1) {
    throw new Error(
      `Invalid --repetitions value ${JSON.stringify(repetitionsText)}.`,
    );
  }
  const cases = values.get("cases")
    ? parseList(values.get("cases")!, "--cases")
    : undefined;

  return {
    targets,
    ...(profile ? { profile } : {}),
    cases,
    repetitions,
    output: resolve(cwd, values.get("output") ?? ".eval-results"),
    keep: switches.has("keep"),
    debug: switches.has("debug"),
    dryRun: switches.has("dry-run"),
  };
}

function parseTargets(value: string): readonly EvalTargetName[] {
  if (value === "all") return [...EVAL_TARGET_NAMES];
  const requested = parseList(value, "--targets");
  const targets: EvalTargetName[] = [];
  for (const item of requested) {
    if (!EVAL_TARGET_NAMES.includes(item as EvalTargetName)) {
      throw new Error(`Unknown eval target ${JSON.stringify(item)}.`);
    }
    if (!targets.includes(item as EvalTargetName)) {
      targets.push(item as EvalTargetName);
    }
  }
  return targets;
}

function parseProfile(value: string): EvalProfile {
  if (!EVAL_PROFILES.includes(value as EvalProfile)) {
    throw new Error(`Unknown eval profile ${JSON.stringify(value)}.`);
  }
  return value as EvalProfile;
}

function parseList(value: string, flag: string): string[] {
  const items = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (items.length === 0) throw new Error(`${flag} cannot be empty.`);
  return [...new Set(items)];
}
