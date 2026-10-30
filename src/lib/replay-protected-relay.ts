// Evolu's Node relay does not currently expose a storage-decorator hook. This
// module mirrors its small Node/WebSocket adapter so we can put the compaction
// replay guard directly around the upstream SQLite storage. Protocol parsing,
// reconciliation, encryption, persistence, and task lifetimes remain Evolu
// implementations.
// Adapter safeguards follow @evolu/nodejs 4.4.3: heartbeat activity, broadcast
// backlog, request fairness/backpressure, HTTP health, and shutdown guards.

import {
  assert,
  callback,
  createRelation,
  createSqlite,
  daemon,
  Name,
  ok,
  Port,
  type PositiveDuration,
  type OwnerId,
  type Task,
  type TimeoutId,
  sql,
  tryAsync,
  trySync,
  yieldNow,
  Uint8Array as EvoluUint8Array,
} from "@evolu/common";
import {
  applyProtocolMessageAsRelay,
  createBaseSqliteStorageTables,
  createRelaySqliteStorage,
  createRelayStorageTables,
  createProtocolMessageBuffer,
  defaultProtocolMessageMaxSize,
  MessageType,
  parseOwnerIdFromOwnerWebSocketTransportUrl,
  type ApplyProtocolMessageAsRelayOptions,
  type Relay,
  type RelayConfig,
  type StorageDep,
} from "@evolu/common/local-first";
import type { RelayDeps } from "@evolu/nodejs";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { createCompactionReplayGuard } from "./compaction-replay.js";
import type { Logger } from "./logger.js";

export interface ReplayProtectedRelayConfig extends RelayConfig {
  readonly port?: Port;
  readonly pingInterval?: PositiveDuration;
  /** Retained for deployment compatibility; Logger applies the actual level. */
  readonly enableLogging?: boolean;
}

interface LoggerDep {
  readonly logger: Logger;
}

type ReplayProtectedRelayDeps = RelayDeps & LoggerDep;

export const createReplayProtectedRelay = ({
  port = Port.orThrow(443),
  name = Name.orThrow("evolu-relay"),
  isOwnerAllowed,
  isOwnerWithinQuota,
  pingInterval = "30s",
}: ReplayProtectedRelayConfig): Task<Relay, never, ReplayProtectedRelayDeps> =>
  async (run) => {
    await using disposer = new AsyncDisposableStack();
    const { logger } = run.deps;
    const relayConsole = run.deps.console;

    const dbFileExists = existsSync(`${name}.db`);
    const sqlite = disposer.use(await run.ok(createSqlite(name)));
    const sqliteDeps = { ...run.deps, sqlite };

    if (!dbFileExists) {
      createBaseSqliteStorageTables(sqliteDeps);
      createRelayStorageTables(sqliteDeps);
    }

    const baseStorage = createRelaySqliteStorage(sqliteDeps)({
      isOwnerWithinQuota,
    });
    const replayGuard = disposer.use(
      createCompactionReplayGuard(`${name}.db`, baseStorage, logger),
    );
    const storage = replayGuard.storage;
    const relayRun = disposer.use(run.create({ storage }));
    const activeSockets = new WeakSet<WebSocket>();
    const unsentBroadcastBytesBySocket = new WeakMap<WebSocket, number>();
    const maxUnsentBroadcastBytes = 16 * defaultProtocolMessageMaxSize;
    let pingTimeoutId: TimeoutId | null = null;
    let isDisposing = false;

    const server = disposer.use(createServer());
    server.once("close", () => {
      relayConsole.log("Evolu Relay HTTP server disposed");
    });

    // Match upstream's storage-readability probe. The private admin endpoint
    // additionally checks our required tables and replay-protection readiness.
    server.on("request", (request, response) => {
      const path = request.url?.split("?")[0];
      if (path === "/health" && (request.method === "GET" || request.method === "HEAD")) {
        const check = trySync(() => {
          if (isDisposing || relayRun.signal.aborted) throw new Error("Relay is stopping");
          sqlite.exec(sql`select count(*) from sqlite_schema;`);
        });
        if (!check.ok) relayConsole.error("[relay]", "health check failed", { error: check.error });
        response.writeHead(check.ok ? 200 : 503, { "content-type": "application/json" });
        response.end(JSON.stringify({ status: check.ok ? "ok" : "error" }));
        return;
      }
      response.writeHead(426, { connection: "Upgrade", upgrade: "websocket" });
      response.end();
    });

    const wss = disposer.adopt(
      new WebSocketServer({
        maxPayload: defaultProtocolMessageMaxSize,
        noServer: true,
      }),
      (webSocketServer) =>
        new Promise<void>((resolve) => {
          webSocketServer.close(() => {
            relayConsole.log("Evolu Relay WebSocket server disposed");
            resolve();
          });
        }),
    );
    const ownerSocketRelation = createRelation<OwnerId, WebSocket>();

    // Paused connections cannot answer pings while their requests are served.
    // Buffered replies and incoming data also keep slow paths alive.
    const pingClients = (): void => {
      for (const client of wss.clients) {
        if (client.readyState !== WebSocket.OPEN || client.bufferedAmount > 0 || client.isPaused) continue;
        if (!activeSockets.has(client)) {
          relayConsole.debug("[relay]", "unresponsive connection");
          client.terminate();
          continue;
        }
        activeSockets.delete(client);
        client.ping();
      }
      pingTimeoutId = run.deps.time.setTimeout(pingClients, pingInterval);
    };
    pingTimeoutId = run.deps.time.setTimeout(pingClients, pingInterval);
    disposer.defer(() => {
      if (pingTimeoutId !== null) run.deps.time.clearTimeout(pingTimeoutId);
    });

    server.on("upgrade", (request, socket, head) => {
      const onSocketError = (error: Error) => {
        relayConsole.warn("[relay]", "socket error", { error: error.message });
      };
      socket.on("error", onSocketError);

      if (isDisposing || relayRun.signal.aborted) {
        socket.destroy();
        return;
      }

      const completeUpgrade = () => {
        if (isDisposing || relayRun.signal.aborted || socket.destroyed) {
          socket.destroy();
          return;
        }
        socket.removeListener("error", onSocketError);
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit("connection", ws, request);
        });
      };

      if (!isOwnerAllowed) {
        completeUpgrade();
        return;
      }

      const respondAndDestroy = (
        status:
          | "400 Bad Request"
          | "401 Unauthorized"
          | "503 Service Unavailable",
      ) => {
        if (socket.destroyed) return;
        socket.write(`HTTP/1.1 ${status}\r\n\r\n`);
        socket.destroy();
      };

      const ownerId = request.url
        ? parseOwnerIdFromOwnerWebSocketTransportUrl(request.url)
        : undefined;
      if (!ownerId) {
        relayConsole.warn("[relay]", "invalid or missing ownerId in URL", {
          url: request.url,
        });
        respondAndDestroy("400 Bad Request");
        return;
      }

      const authorizationFiber = relayRun.abortable(
        daemon(async (authorizationRun) =>
          tryAsync(
            () => isOwnerAllowed(ownerId, { signal: authorizationRun.signal }),
            (error) => ({ type: "OwnerAuthorizationError", error }) as const,
          ),
        ),
      );
      const abortAuthorization = () => {
        authorizationFiber.abort({ type: "WebSocketUpgradeSocketClosed" });
      };
      socket.once("close", abortAuthorization);
      socket.once("error", abortAuthorization);

      void (async () => {
        const result = await authorizationFiber;
        socket.removeListener("close", abortAuthorization);
        socket.removeListener("error", abortAuthorization);

        if (!result.ok) {
          if (result.error.type === "AbortError") {
            socket.destroy();
            return;
          }
          relayConsole.error("[relay]", "authorization error", {
            error: String(result.error.error),
          });
          respondAndDestroy("503 Service Unavailable");
          return;
        }
        if (!result.value) {
          relayConsole.warn("[relay]", "unauthorized owner", { ownerId });
          respondAndDestroy("401 Unauthorized");
          return;
        }
        completeUpgrade();
      })().catch((error: unknown) => {
        relayConsole.error("[relay]", "authorization error", { error: String(error) });
        respondAndDestroy("503 Service Unavailable");
      });
    });

    wss.on("connection", (ws, request) => {
      activeSockets.add(ws);
      const markActive = () => activeSockets.add(ws);
      request.socket.on("data", markActive);
      relayConsole.log("[relay]", "connection", {
        totalConnectionCount: wss.clients.size,
      });

      ws.on("error", (error) => {
        relayConsole.warn("[relay]", "socket error", { error: error.message });
      });

      const broadcast = (ownerId: OwnerId, message: Uint8Array): void => {
        let broadcastCount = 0;
        for (const socket of ownerSocketRelation.iterateB(ownerId)) {
          if (socket === ws || socket.readyState !== WebSocket.OPEN) continue;
          const unsent = (unsentBroadcastBytesBySocket.get(socket) ?? 0) + message.byteLength;
          if (unsent > maxUnsentBroadcastBytes) {
            relayConsole.debug("[relay]", "broadcast backlog exceeded", { ownerId });
            socket.terminate();
            continue;
          }
          unsentBroadcastBytesBySocket.set(socket, unsent);
          socket.send(message, { binary: true }, () => {
            unsentBroadcastBytesBySocket.set(socket,
              (unsentBroadcastBytesBySocket.get(socket) ?? 0) - message.byteLength);
          });
          broadcastCount++;
        }
        relayConsole.debug("[relay]", "broadcast", {
          ownerId, broadcastCount,
          subscriptionCount: ownerSocketRelation.bCountForA(ownerId),
        });
      };
      const options: ApplyProtocolMessageAsRelayOptions = {
        subscribe: (ownerId) => {
          ownerSocketRelation.add(ownerId, ws);
          relayConsole.log("[relay]", "subscribe", {
            ownerId,
            subscriptionCount: ownerSocketRelation.bCountForA(ownerId),
          });
        },
        unsubscribe: (ownerId) => {
          ownerSocketRelation.remove(ownerId, ws);
          relayConsole.log("[relay]", "unsubscribe", {
            ownerId,
            subscriptionCount: ownerSocketRelation.bCountForA(ownerId),
          });
        },
        // The storage guard broadcasts accepted messages while holding the
        // owner lock; the protocol's unfiltered broadcast is deliberately off.
      };

      // Serve one request at a time and yield between requests. Pausing reads
      // keeps additional traffic in TCP; waiting for each send callback bounds
      // replies for peers that stop reading. A read already being parsed can
      // still deliver several messages, so keep those in arrival order.
      const requests: Uint8Array[] = [];
      let stopServing: (() => void) | undefined;
      const serveRequests: Task<void, never, StorageDep> = async (processingRun) => {
        try {
          while (requests.length > 0) {
            await processingRun.ok(yieldNow);
            if (isDisposing || ws.readyState !== WebSocket.OPEN) break;
            const request = requests.shift();
            if (request === undefined) break;

            await using messageRun = processingRun.create({
              storage: replayGuard.withBroadcast((ownerId, messages) => {
                const frame = createProtocolMessageBuffer(ownerId, {
                  messageType: MessageType.Broadcast,
                });
                for (const accepted of messages) frame.addMessage(accepted);
                broadcast(ownerId, frame.unwrap());
              }),
            });
            const response = await messageRun.abortable(
              applyProtocolMessageAsRelay(request, options),
            );
            if (!response.ok) {
              if (response.error.type === "AbortError") break;
              // Invalid peer traffic must not flood the default operational log.
              relayConsole.debug("[relay]", "invalid protocol request", {
                byteLength: request.length,
                error: response.error.error,
              });
              continue;
            }
            if (isDisposing || ws.readyState !== WebSocket.OPEN) break;
            await processingRun.ok(callback<void>(({ resolve }) => {
              ws.send(response.value.message, { binary: true }, () => resolve(ok()));
            }));
            relayConsole.debug("[relay]", "responseLength", {
              length: response.value.message.length,
            });
          }
        } finally {
          // Also resume during shutdown so the peer's close frame can be read.
          ws.resume();
        }
        return ok();
      };

      ws.on("message", (message) => {
        if (isDisposing || relayRun.signal.aborted || !EvoluUint8Array.is(message)) return;
        requests.push(message);
        if (ws.isPaused) return;
        ws.pause();
        const serving = relayRun.abortable(serveRequests);
        stopServing = () => serving.abort({ type: "WebSocketClosed" });
        void serving.catch((error: unknown) => {
          relayConsole.error("[relay]", "applyProtocolMessageAsRelayUnknownError", {
            error: String(error),
          });
          ws.terminate();
        });
      });

      ws.on("close", () => {
        requests.length = 0;
        stopServing?.();
        request.socket.removeListener("data", markActive);
        ownerSocketRelation.removeByB(ws);
        relayConsole.log("[relay]", "close", {
          totalConnectionCount: wss.clients.size,
        });
      });
    });

    disposer.defer(() => {
      isDisposing = true;
      relayConsole.log("Shutting down Evolu Relay");
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          client.close(1000, "Evolu Relay shutting down");
        }
      }
    });

    server.listen(port);
    await once(server, "listening");
    const address = server.address();
    assert(
      address !== null && typeof address !== "string",
      "Expected TCP address",
    );

    const disposables = disposer.move();
    relayConsole.log(`Evolu Relay started on port ${address.port}`);

    return ok({
      port: address.port,
      [Symbol.asyncDispose]: () => disposables.disposeAsync(),
    });
  };
