import { Runtime } from "@elem-app/arc/runtime";

import type { ResolvedDocumentSnapshot } from "../types/host.js";

/** Initialize the captured definitions in registration order with their host declarations. */
export function createDocumentRuntime(
  snapshot: ResolvedDocumentSnapshot,
): Runtime {
  const runtime = new Runtime({ hostModules: snapshot.hostModules });
  for (const { source, document } of snapshot.documents)
    runtime.add(source, document);
  return runtime.init();
}
