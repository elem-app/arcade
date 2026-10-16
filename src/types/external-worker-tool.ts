import type * as z from "zod/v4";

import type { RoutineEffects } from "./routine.js";
import type { Task } from "./task.js";

/**
 * Per-invocation context handed to an {@link ExternalWorkerTool}'s `execute`.
 *
 * The hosting backend constructs this each time the worker calls the tool and
 * delivers it as `execute`'s second argument. It exposes only the slice of
 * worker session state that is safe and useful for a tool to read; the backend's
 * private machinery (outbound emit channel, report resolver, permission and
 * question resolvers, remembered grants, transport handles) is intentionally
 * withheld.
 */
export type ExternalWorkerToolContext = {
  /** Identifier of the arc run the calling worker belongs to. */
  arcRunId: string;
  /** Identifier of the routine (one role activation) issuing the call. */
  routineId: string;
  /** Arc role the worker is fulfilling (the activated node's `workerRole`). */
  role: string;
  /**
   * The task the worker is executing. Carries the brief, dialog, and — for
   * instruction tasks — the declared tool surface, so a tool can tailor its
   * behavior to what was actually asked of the worker.
   */
  task: Task;
  /**
   * Absolute working directory of the worker process. Resolve any relative path
   * a tool is given (e.g. a staged attachment named in the task) against this.
   */
  cwd: string;
  /**
   * Absolute path to the routine's writable workspace, when one was staged.
   * Distinct from {@link cwd}: the workspace is the sandboxed root the worker is
   * permitted to read and write, so tools that materialize files should target
   * it. Absent when the routine runs without a staged workspace.
   */
  workspacePath?: string;
  /**
   * Append an originator-visible tool event. A tool calls this to surface its
   * own progress and observability into the same work-event stream the backend
   * writes, so external tool activity is auditable alongside the built-in tools.
   */
  logToolEvent: RoutineEffects["logToolEvent"];
};

/**
 * An embedder-supplied tool mounted into a worker alongside the built-in ones.
 *
 * The embedder constructs this object and passes it to a backend; the backend
 * adapts it to the host SDK's native tool shape and registers it.
 */
export type ExternalWorkerTool = {
  /** Wire name the model calls. Must be unique among the worker's tools. */
  name: string;
  /**
   * One-line description shown to the model; it decides when to call the tool
   * from this text.
   */
  description: string;
  /**
   * Per-property Zod schema for the tool input, consumed by SDKs that accept a
   * Zod shape (the Claude in-process MCP tool). Keep it in lockstep with
   * {@link jsonSchema}: the two describe the same input for different SDKs.
   */
  inputSchema: Record<string, z.ZodType>;
  /**
   * JSON Schema for the tool input, consumed by SDKs that take a raw schema (the
   * OpenAI Agents `tool`). The same shape as {@link inputSchema}, expressed as
   * plain JSON Schema.
   */
  jsonSchema: Record<string, unknown>;
  /**
   * Run the tool. `input` is the model-supplied arguments, passed through
   * unparsed — validate them against the schema inside the implementation;
   * `context` is the per-invocation {@link ExternalWorkerToolContext}. The
   * resolved value is serialized back to the model as the tool result.
   */
  execute: (
    input: Record<string, unknown>,
    context: ExternalWorkerToolContext,
  ) => Promise<unknown>;
};
