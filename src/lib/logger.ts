// Structured logging Console that intercepts Evolu's relay logger.
//
// Evolu's createRelayLogger calls our Console methods with patterns like:
//   log("[relay]", "connection", { totalConnectionCount })
//   error("[relay]", "storage", error)
//   log("Evolu Relay started on port 4000")
//
// We parse these into structured JSON events at appropriate log levels.

import { createConsole, type Console, type ConsoleEntry } from "@evolu/common";
import type { RelayConfig } from "./config.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<string, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const TAG_LEVELS: Record<string, LogLevel> = {
  connection: "info",
  close: "info",
  subscribe: "info",
  unsubscribe: "info",
  broadcast: "debug",
  "on message": "debug",
  responseLength: "debug",
  storage: "error",
  error: "error",
  "socket error": "warn",
  "invalid or missing ownerId in URL": "warn",
  "unauthorized owner": "warn",
  applyProtocolMessageAsRelay: "error",
  applyProtocolMessageAsRelayUnknownError: "error",
};

export interface Logger {
  console: Console;
  emit: (level: LogLevel, event: string, data?: Record<string, unknown>) => void;
  getCurrentConnections: () => number;
  setOwnerCallback: (fn: (ownerId: string) => void) => void;
}

export function createLogger(config: RelayConfig): Logger {
  const minLevel = LEVELS[config.logLevel] ?? LEVELS.info;
  const isJson = config.logFormat === "json";
  let currentConnections = 0;
  let onOwnerSeen: ((ownerId: string) => void) | null = null;

  function shouldLog(level: LogLevel): boolean {
    return (LEVELS[level] ?? 0) >= minLevel;
  }

  function emit(
    level: LogLevel,
    event: string,
    data?: Record<string, unknown>,
  ): void {
    if (!shouldLog(level)) return;

    const stream = level === "error" ? process.stderr : process.stdout;
    const seen = new WeakSet<object>();
    const serialize = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => {
      if (typeof item === "bigint") return item.toString();
      if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack };
      if (item !== null && typeof item === "object") {
        if (seen.has(item)) return "[Circular]";
        seen.add(item);
      }
      return item;
    });

    if (isJson) {
      stream.write(
        serialize({ ts: new Date().toISOString(), level, event, ...data }) +
          "\n",
      );
    } else {
      const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}]`;
      const detail =
        data && Object.keys(data).length > 0
          ? " " + serialize(data)
          : "";
      stream.write(`${prefix} ${event}${detail}\n`);
    }
  }

  function parseRelayLog(entry: ConsoleEntry): void {
    const args = [...entry.args];
    const methodLevel: LogLevel = entry.method === "error" ? "error"
      : entry.method === "warn" ? "warn" : entry.method === "info" ? "info" : "debug";
    if (args[0] === "[relay]") {
      const tag = args[1] as string;
      const data = (args[2] as Record<string, unknown>) ?? {};
      const level: LogLevel = TAG_LEVELS[tag] || methodLevel;

      if (
        tag === "connection" &&
        typeof data.totalConnectionCount === "number"
      ) {
        currentConnections = data.totalConnectionCount;
      }
      if (tag === "close" && typeof data.totalConnectionCount === "number") {
        currentConnections = data.totalConnectionCount;
      }
      if (tag === "subscribe" && typeof data.ownerId === "string" && onOwnerSeen) {
        onOwnerSeen(data.ownerId);
      }

      emit(level, `relay.${tag.replace(/\s+/g, "_")}`, data);
      return;
    }

    const msg = typeof args[0] === "string" ? args[0] : "";
    if (msg.startsWith("Evolu Relay started")) {
      emit("info", "relay.started", { message: msg });
    } else if (msg.startsWith("Shutting down")) {
      emit("info", "relay.shutdown");
    } else if (msg.includes("disposed")) {
      emit("info", "relay.disposed", { message: msg });
    } else {
      // Do not turn upstream errors into debug-only entries. Preserve native
      // Console scopes, and keep raw diagnostic output behind the existing flag.
      if (methodLevel === "debug" && !config.enableEvoluLogging) return;
      emit(methodLevel, "relay.internal", {
        scope: entry.path,
        args: args.map((arg) => arg instanceof Error
          ? { name: arg.name, message: arg.message, stack: arg.stack } : arg),
      });
    }
  }

  // Keep Evolu's structured console at trace level so owner subscription events
  // always reach the tracker. The relay logger above applies the configured
  // output level after translating those entries into stable JSON events.
  const consoleImpl = createConsole({
    level: "trace",
    output: {
      write: parseRelayLog,
    },
  });

  return {
    console: consoleImpl,
    emit,
    getCurrentConnections: () => currentConnections,
    setOwnerCallback: (fn) => {
      onOwnerSeen = fn;
    },
  };
}
