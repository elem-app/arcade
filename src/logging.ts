export type ArcadeLogLevel = "silent" | "info" | "debug";
export type ArcadeLogFormat = "json" | "pretty";

export type ArcadeLogRecord = Record<string, unknown> & {
  /** ISO timestamp captured when the application submits the record. */
  at: string;
  /** Monotonic submission order within this logger instance. */
  sequence: number;
  level: Exclude<ArcadeLogLevel, "silent">;
  event: string;
};

/** Synchronous acceptance boundary for structured Arcade log records. */
export type ArcadeLogSink = {
  write(record: ArcadeLogRecord): void;
};

export type ArcadeLogger = {
  level: ArcadeLogLevel;
  format: ArcadeLogFormat;
  info(event: string, fields?: Record<string, unknown>): void;
  debug(event: string, fields?: Record<string, unknown>): void;
};

const LEVELS: Record<ArcadeLogLevel, number> = {
  silent: 0,
  info: 1,
  debug: 2,
};

export function createArcadeLogger(
  level: ArcadeLogLevel = "silent",
  format: ArcadeLogFormat = "json",
  sink: ArcadeLogSink = createStdioArcadeLogSink(format),
): ArcadeLogger {
  let sequence = 0;
  const write = (
    messageLevel: Exclude<ArcadeLogLevel, "silent">,
    event: string,
    fields: Record<string, unknown> = {},
  ): void => {
    if (LEVELS[level] < LEVELS[messageLevel]) return;
    sequence += 1;
    try {
      const record = structuredClone<ArcadeLogRecord>({
        ...fields,
        at: new Date().toISOString(),
        sequence,
        level: messageLevel,
        event,
      });
      sink.write(record);
    } catch (error) {
      try {
        process.emitWarning(
          error instanceof Error ? error : new Error(String(error)),
          { code: "ARCADE_LOG_SINK_ERROR" },
        );
      } catch {
        // Logging must remain observational even when warning delivery fails.
      }
    }
  };
  return {
    level,
    format,
    info: (event, fields) => write("info", event, fields),
    debug: (event, fields) => write("debug", event, fields),
  };
}

/** Create the built-in synchronous stdout sink. */
export function createStdioArcadeLogSink(
  format: ArcadeLogFormat = "json",
): ArcadeLogSink {
  return {
    write(record) {
      const json = JSON.stringify(record);
      console.log(format === "pretty" ? `[arcade] ${json}` : json);
    },
  };
}

export function previewLogValue(value: unknown, maxLength = 160): string {
  const text = serializeLogPreview(value);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function serializeLogPreview(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return (
      JSON.stringify(value, (_key, nested) =>
        typeof nested === "bigint" ? `${nested}n` : nested,
      ) ?? String(value)
    );
  } catch {
    try {
      return String(value);
    } catch {
      return "[unserializable]";
    }
  }
}
