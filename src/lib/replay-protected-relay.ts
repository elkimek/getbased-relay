// Evolu's Node relay does not currently expose a storage-decorator hook. This
// module mirrors its small Node/WebSocket adapter so we can put the compaction
// replay guard directly around the upstream SQLite storage. Protocol parsing,
// reconciliation, encryption, persistence, and task lifetimes remain Evolu
// implementations.
// Adapter safeguards are aligned with @evolu/nodejs 4.1.0 in Evolu relay
// 4.1.3 (4c01beb0): heartbeat activity, broadcast backlog, and shutdown guards.

import {
  assert,
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
  tryAsync,
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

    // Mirrors @evolu/nodejs 4.1.0: incoming data counts as activity, and
    // buffered replies delay pinging so slow uploads/downloads stay connected.
    const pingClients = (): void => {
      for (const client of wss.clients) {
        if (client.readyState !== WebSocket.OPEN || client.bufferedAmount > 0) continue;
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

      ws.on("message", (message) => {
        if (isDisposing || relayRun.signal.aborted || !EvoluUint8Array.is(message)) return;
        relayConsole.debug("[relay]", "on message", {
          length: message.length,
        });

        void (async () => {
          await using messageRun = relayRun.create({
            storage: replayGuard.withBroadcast((ownerId, messages) => {
              const frame = createProtocolMessageBuffer(ownerId, {
                messageType: MessageType.Broadcast,
              });
              for (const accepted of messages) frame.addMessage(accepted);
              broadcast(ownerId, frame.unwrap());
            }),
          });
          const response = await messageRun.abortable(
            applyProtocolMessageAsRelay(message, options),
          );
          if (!response.ok) {
            if (response.error.type === "AbortError") return;
            relayConsole.error("[relay]", "applyProtocolMessageAsRelay", {
              error: response.error,
            });
            return;
          }
          if (isDisposing || ws.readyState !== WebSocket.OPEN) return;
          ws.send(response.value.message, { binary: true });
          relayConsole.debug("[relay]", "responseLength", {
            length: response.value.message.length,
          });
        })().catch((error: unknown) => {
          relayConsole.error(
            "[relay]",
            "applyProtocolMessageAsRelayUnknownError",
            { error: String(error) },
          );
        });
      });

      ws.on("close", () => {
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
