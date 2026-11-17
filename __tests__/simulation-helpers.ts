import { parse } from "@elem-app/arc/parser";
import { toArcRef } from "@elem-app/arc/runtime";
import type { HostModuleSpec } from "@elem-app/arc/types";

import { SimulatorService, type SimulationOptions } from "../src/testing.js";

/** Empty fixed Dialog shared by simulation fixtures. */
export const dialog = { lastTurns: [], cursor: { user: 0, self: 0 } };
/** Inventory declarations used by fixtures that simulate host calls. */
export const inventory: HostModuleSpec = {
  kind: "namespace",
  members: {
    write: { kind: "operation", parameters: [] },
    available: {
      kind: "operation",
      parameters: [{ type: "number" }],
      returns: { type: "boolean" },
    },
  },
};

/** Build a standalone simulator for the fixture root and its declared imports. */
export function fixture(text: string, extra: Record<string, string> = {}) {
  const document = parse(text);
  const arcRef = toArcRef("fixture", document.roots[0]!.identifier);
  const simulator = new SimulatorService({
    captureSnapshot: async () => ({
      documents: [
        { source: "fixture", document },
        ...Object.entries(extra).map(([source, value]) => ({
          source,
          document: parse(value),
        })),
      ],
      hostModules: new Map([["inventory", inventory]]),
    }),
  });
  return {
    simulator,
    run: (options: Partial<SimulationOptions> = {}) =>
      simulator.simulate({ arcRef, dialog, ...options }),
  };
}
