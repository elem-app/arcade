import { hmd } from "@elem-app/arc/host-utils";
import type { HostModuleSpec } from "@elem-app/arc/types";

/** Declaration of `host:time`: the clock, calendar math, and timeouts. */
export const timeDeclaration = hmd.define({
  addTimeout: (milliseconds = hmd.Num(), id = hmd.Omittable(hmd.Str())) => {},
  removeTimeout: (id = hmd.Str()) => {},
  sleep: (milliseconds = hmd.Num()) => {},
  nowMillis: () => hmd.Num(),
  offset: (
    ts = hmd.Num(),
    offset = hmd.Struct({
      years: hmd.Omittable(hmd.Num()),
      months: hmd.Omittable(hmd.Num()),
      days: hmd.Omittable(hmd.Num()),
      hours: hmd.Omittable(hmd.Num()),
      minutes: hmd.Omittable(hmd.Num()),
      seconds: hmd.Omittable(hmd.Num()),
    }),
    timeZone = hmd.Omittable(hmd.Str()),
  ) => hmd.Num(),
  startOf: (
    ts = hmd.Num(),
    unit = hmd.Str(),
    timeZone = hmd.Omittable(hmd.Str()),
  ) => hmd.Num(),
  format: (
    ts = hmd.Num(),
    format = hmd.Str(),
    timeZone = hmd.Omittable(hmd.Str()),
  ) => hmd.Str(),
});

/** Declaration of `host:audience`, whose member paths are host variables only. */
export const audienceDeclaration: HostModuleSpec = {
  kind: "namespace",
  members: {},
};

/** The host modules every Arcade registers, keyed by module name. */
export const builtInHostModuleDeclarations: ReadonlyMap<
  string,
  HostModuleSpec
> = new Map([
  ["time", timeDeclaration],
  ["audience", audienceDeclaration],
]);
