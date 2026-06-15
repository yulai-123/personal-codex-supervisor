export type LogLevel = "debug" | "info" | "warn" | "error";

export type Logger = {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
};

export type LoggerOptions = {
  level: LogLevel;
  base?: Record<string, unknown>;
};

const levelRank: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function createLogger(options: LoggerOptions): Logger {
  return createLoggerWithBase(options.level, options.base ?? {});
}

function createLoggerWithBase(level: LogLevel, base: Record<string, unknown>): Logger {
  const write = (entryLevel: LogLevel, message: string, fields: Record<string, unknown> = {}) => {
    if (levelRank[entryLevel] < levelRank[level]) {
      return;
    }

    const entry = redact({
      time: new Date().toISOString(),
      level: entryLevel,
      message,
      ...base,
      ...fields,
    });
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  };

  return {
    debug: (message, fields) => write("debug", message, fields),
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
    child: (fields) => createLoggerWithBase(level, { ...base, ...fields }),
  };
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = shouldRedact(key) ? "[redacted]" : redact(item);
  }
  return output;
}

function shouldRedact(key: string): boolean {
  return /secret|token|password|credential|private.?key/i.test(key);
}
