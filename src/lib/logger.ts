// Structured logging Console that intercepts Evolu's relay logger.
//
// Evolu's createRelayLogger calls our Console methods with patterns like:
//   log("[relay]", "connection", { totalConnectionCount })
//   error("[relay]", "storage", error)
//   log("Evolu Relay started on port 4000")
//
// We parse these into structured JSON events at appropriate log levels.

import { createConsole, type Console } from "@evolu/common";
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

    if (isJson) {
      stream.write(
        JSON.stringify({ ts: new Date().toISOString(), level, event, ...data }) +
          "\n",
      );
    } else {
      const prefix = `[${new Date().toISOString()}] [${level.toUpperCase()}]`;
      const detail =
        data && Object.keys(data).length > 0
          ? " " + JSON.stringify(data)
          : "";
      stream.write(`${prefix} ${event}${detail}\n`);
    }
  }

  function parseRelayLog(_method: string, args: unknown[]): void {
    if (args[0] === "[relay]") {
      const tag = args[1] as string;
      const data = (args[2] as Record<string, unknown>) ?? {};
      const level: LogLevel = TAG_LEVELS[tag] || "debug";

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
      emit("debug", "relay.internal", { args: args.map(String) });
    }
  }

  // Keep Evolu's structured console at trace level so owner subscription events
  // always reach the tracker. The relay logger above applies the configured
  // output level after translating those entries into stable JSON events.
  const consoleImpl = createConsole({
    level: "trace",
    output: {
      write: (entry) => parseRelayLog(entry.method, [...entry.args]),
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
