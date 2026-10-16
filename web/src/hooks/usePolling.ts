import { useCallback, useEffect, useRef, useState } from "react";
import {
  getHandshakeWorkEvents,
  getHealth,
  getOutbound,
  getRunDetail,
  getRuns,
} from "../api/client";
import type {
  EntryReceipt,
  HealthResponse,
  OutboundItem,
  RunDetail,
  RunSummary,
  WorkEvent,
} from "../types";

export type DetailStatus = "idle" | "loading" | "loaded" | "missing";
export type HandshakeActivity = {
  id: string;
  arcRunId: string;
  prompt?: string;
  candidates?: EntryReceipt["handshakeRunCandidates"];
  freshAvailable?: boolean;
  status: "pending" | "resolved" | "ended";
  outcome?: Extract<WorkEvent, { kind: "run:handshake-resolved" }>["outcome"];
};

export function mergeWorkEvents(
  existing: readonly WorkEvent[],
  incoming: readonly WorkEvent[],
): WorkEvent[] {
  const byId = new Map(existing.map((event) => [event.id, event]));
  for (const event of incoming)
    if (!byId.has(event.id)) byId.set(event.id, event);
  return [...byId.values()];
}

export function usePolling(
  selectedRunId: string | null,
  options: { disabled?: boolean } = {},
) {
  const [runs, setRunsState] = useState<RunSummary[]>([]);
  const [health, setHealth] = useState<HealthResponse>();
  const [details, setDetails] = useState<Record<string, RunDetail>>({});
  const [statuses, setStatuses] = useState<Record<string, DetailStatus>>({});
  const [histories, setHistories] = useState<Record<string, WorkEvent[]>>({});
  const [handshakes, setHandshakes] = useState<
    Record<string, HandshakeActivity>
  >({});
  const selectedRef = useRef(selectedRunId);
  selectedRef.current = selectedRunId;
  const runsRef = useRef(runs);
  const historyRef = useRef<Record<string, WorkEvent[]>>({});
  const handshakeRef = useRef<Record<string, HandshakeActivity>>({});
  const refreshRef = useRef<() => void>(() => {});
  const selectionRef = useRef<(id: string) => void>(() => {});
  const handshakeLoadRef = useRef<(id: string) => void>(() => {});

  const setRuns = useCallback((next: RunSummary[]) => {
    runsRef.current = next;
    setRunsState(next);
  }, []);
  const refreshNow = useCallback(() => refreshRef.current(), []);
  const invalidate = useCallback(() => {}, []);
  const registerHandshake = useCallback((receipt: EntryReceipt) => {
    const id = receipt.handshakeId;
    if (receipt.status !== "handshake-required" || !id || !receipt.arcRunId)
      return;
    handshakeRef.current = {
      ...handshakeRef.current,
      [id]: {
        ...handshakeRef.current[id],
        id,
        arcRunId: receipt.arcRunId,
        status: handshakeRef.current[id]?.status ?? "pending",
        prompt: receipt.handshakePrompt,
        candidates: receipt.handshakeRunCandidates,
        freshAvailable: receipt.handshakeFreshAvailable,
      },
    };
    setHandshakes(handshakeRef.current);
    handshakeLoadRef.current(id);
  }, []);

  useEffect(() => {
    if (options.disabled) return;
    let alive = true;
    let ready = false;
    let loading = false;
    let queued = false;
    let epoch = 0;
    let listSequence = 0;
    let tickSequence = 0;
    const detailSequences = new Map<string, number>();
    let buffered: WorkEvent[] = [];
    const controllers = new Set<AbortController>();
    const controller = () => {
      const value = new AbortController();
      controllers.add(value);
      return value;
    };
    const rememberEvents = (events: readonly WorkEvent[]) => {
      for (const event of events) {
        if (
          event.kind !== "run:handshake-pending" &&
          event.kind !== "run:handshake-resolved"
        )
          continue;
        const old = handshakeRef.current[event.handshakeId];
        handshakeRef.current[event.handshakeId] = {
          ...old,
          id: event.handshakeId,
          arcRunId: event.arcRunId,
          status:
            event.kind === "run:handshake-resolved"
              ? "resolved"
              : (old?.status ?? "pending"),
          ...(event.kind === "run:handshake-resolved"
            ? { outcome: event.outcome }
            : {}),
        };
      }
      setHandshakes({ ...handshakeRef.current });
    };
    const install = (id: string, events: WorkEvent[], history = false) => {
      const old = historyRef.current[id] ?? [];
      historyRef.current[id] = history
        ? mergeWorkEvents(events, old)
        : mergeWorkEvents(old, events);
      rememberEvents(historyRef.current[id]);
      setHistories({ ...historyRef.current });
    };
    const loadDetail = async (
      id: string,
      signal: AbortSignal,
      generation: number,
    ) => {
      const sequence = (detailSequences.get(id) ?? 0) + 1;
      detailSequences.set(id, sequence);
      const result = await getRunDetail(id, signal);
      if (
        !alive ||
        signal.aborted ||
        generation !== epoch ||
        detailSequences.get(id) !== sequence
      )
        return;
      if (result.ok) {
        install(id, result.data.run.workEvents, true);
        setDetails((current) => ({ ...current, [id]: result.data.run }));
        setStatuses((current) => ({ ...current, [id]: "loaded" }));
      } else if (result.status === 404) {
        setDetails((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
        setStatuses((current) => ({ ...current, [id]: "missing" }));
      }
    };
    const loadHandshake = async (
      id: string,
      signal: AbortSignal,
      generation: number,
    ) => {
      const activity = handshakeRef.current[id];
      if (!activity) return;
      const result = await getHandshakeWorkEvents(
        id,
        activity.arcRunId,
        signal,
      );
      if (!alive || signal.aborted || generation !== epoch) return;
      if (result.ok) install(result.data.arcRunId, result.data.events, true);
    };
    const refresh = async () => {
      if (!ready || !alive) return;
      if (loading) {
        queued = true;
        return;
      }
      loading = true;
      queued = false;
      const generation = epoch;
      const abort = controller();
      try {
        const sequence = ++listSequence;
        const result = await getRuns(abort.signal);
        if (
          !alive ||
          abort.signal.aborted ||
          generation !== epoch ||
          sequence !== listSequence
        )
          return;
        if (result.ok) {
          setRuns(result.data.runs);
          const liveIds = new Set(result.data.runs.map((run) => run.id));
          for (const entry of Object.values(handshakeRef.current))
            if (
              entry.status === "pending" &&
              entry.arcRunId &&
              !liveIds.has(entry.arcRunId)
            )
              entry.status = "ended";
          setHandshakes({ ...handshakeRef.current });
        }
        const ids = new Set([
          ...(result.ok ? result.data.runs : runsRef.current).map(
            (run) => run.id,
          ),
          ...Object.keys(historyRef.current),
          ...buffered.map((event) => event.arcRunId),
        ]);
        if (selectedRef.current) ids.add(selectedRef.current);
        await Promise.all(
          [...ids].map((id) => loadDetail(id, abort.signal, generation)),
        );
        rememberEvents(buffered);
        await Promise.all(
          Object.keys(handshakeRef.current).map((id) =>
            loadHandshake(id, abort.signal, generation),
          ),
        );
      } finally {
        controllers.delete(abort);
        if (alive && generation === epoch) {
          for (const event of buffered) install(event.arcRunId, [event]);
          buffered = [];
          loading = false;
          if (queued) {
            queued = false;
            void refresh();
          }
        }
      }
    };
    refreshRef.current = () => void refresh();
    selectionRef.current = (id) => {
      setStatuses((current) => ({ ...current, [id]: "loading" }));
      if (loading || !ready) {
        queued = true;
        return;
      }
      const abort = controller();
      void loadDetail(id, abort.signal, epoch).finally(() =>
        controllers.delete(abort),
      );
    };
    handshakeLoadRef.current = (id) => {
      if (loading || !ready) {
        queued = true;
        return;
      }
      const abort = controller();
      void loadHandshake(id, abort.signal, epoch).finally(() =>
        controllers.delete(abort),
      );
    };
    const source =
      typeof EventSource !== "undefined"
        ? new EventSource("/api/events")
        : undefined;
    source?.addEventListener("stream.ready", () => {
      ready = true;
      void refresh();
    });
    source?.addEventListener("error", () => {
      ready = false;
      epoch += 1;
      loading = false;
      queued = false;
      for (const abort of controllers) abort.abort();
      controllers.clear();
    });
    source?.addEventListener("work.event", (event) => {
      if (!(event instanceof MessageEvent)) return;
      let workEvent: WorkEvent;
      try {
        workEvent = JSON.parse(event.data).event;
      } catch {
        return;
      }
      if (
        !workEvent ||
        typeof workEvent.id !== "string" ||
        typeof workEvent.arcRunId !== "string"
      )
        return;
      if (loading || !ready) buffered.push(workEvent);
      else install(workEvent.arcRunId, [workEvent]);
      if (
        workEvent.kind.startsWith("run:") ||
        workEvent.kind.startsWith("control:") ||
        workEvent.kind === "routine:capacity-limited" ||
        workEvent.kind === "routine:transport-lost" ||
        !runsRef.current.some((run) => run.id === workEvent.arcRunId)
      )
        void refresh();
    });
    const tick = async () => {
      const tickRequest = ++tickSequence;
      const abort = controller();
      const generation = epoch;
      const [healthResult, outboundResult] = await Promise.all([
        getHealth(abort.signal),
        getOutbound(abort.signal),
      ]);
      controllers.delete(abort);
      if (
        !alive ||
        abort.signal.aborted ||
        generation !== epoch ||
        tickRequest !== tickSequence
      )
        return;
      setHealth(healthResult.ok ? healthResult.data : undefined);
      if (outboundResult.ok)
        setDetails((current) =>
          Object.fromEntries(
            Object.entries(current).map(([id, detail]) => [
              id,
              {
                ...detail,
                outbound: outboundResult.data.messages.filter(
                  (item) => item.arcRunId === id,
                ),
              },
            ]),
          ),
        );
      if (
        ready &&
        !loading &&
        runsRef.current.some((run) => run.stage !== "actioning")
      ) {
        const selectedPreparation = runsRef.current.some(
          (run) => run.id === selectedRef.current && run.stage !== "actioning",
        );
        const prepAbort = controller();
        const sequence = ++listSequence;
        const latest = await getRuns(prepAbort.signal);
        if (
          alive &&
          !prepAbort.signal.aborted &&
          generation === epoch &&
          sequence === listSequence &&
          latest.ok
        ) {
          setRuns(latest.data.runs);
          const ids = new Set(latest.data.runs.map((run) => run.id));
          for (const entry of Object.values(handshakeRef.current))
            if (
              entry.status === "pending" &&
              entry.arcRunId &&
              !ids.has(entry.arcRunId)
            )
              entry.status = "ended";
          setHandshakes({ ...handshakeRef.current });
          if (selectedPreparation && selectedRef.current)
            await loadDetail(selectedRef.current, prepAbort.signal, generation);
        }
        controllers.delete(prepAbort);
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 2000);
    return () => {
      alive = false;
      epoch += 1;
      source?.close();
      window.clearInterval(timer);
      for (const abort of controllers) abort.abort();
      refreshRef.current = () => {};
      selectionRef.current = () => {};
      handshakeLoadRef.current = () => {};
    };
  }, [options.disabled, setRuns]);

  useEffect(() => {
    if (selectedRunId && !options.disabled) selectionRef.current(selectedRunId);
  }, [selectedRunId, options.disabled]);
  const setDetail = useCallback(
    (updater: (detail: RunDetail | undefined) => RunDetail | undefined) => {
      const id = selectedRef.current;
      if (id)
        setDetails((current) => {
          const next = updater(current[id]);
          return next ? { ...current, [id]: next } : current;
        });
    },
    [],
  );
  const applyItem = useCallback(
    (item: OutboundItem) =>
      setDetails((current) => {
        const detail = current[item.arcRunId];
        return detail
          ? {
              ...current,
              [item.arcRunId]: {
                ...detail,
                outbound: detail.outbound.map((old) =>
                  old.id === item.id ? item : old,
                ),
              },
            }
          : current;
      }),
    [],
  );
  const detail = selectedRunId ? details[selectedRunId] : undefined;
  return {
    state: {
      runs,
      health,
      detail: detail
        ? { ...detail, workEvents: histories[detail.id] ?? detail.workEvents }
        : undefined,
      detailStatus: selectedRunId
        ? (statuses[selectedRunId] ?? "loading")
        : ("idle" as DetailStatus),
      histories,
      handshakes,
    },
    setRuns,
    setDetail,
    applyItem,
    invalidate,
    refreshNow,
    registerHandshake,
  };
}
