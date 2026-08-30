// Evolu's Node relay does not currently expose a storage-decorator hook. This
// module mirrors its small Node/WebSocket adapter so we can put the compaction
// replay guard directly around the upstream SQLite storage. Protocol parsing,
// reconciliation, encryption, persistence, and task lifetimes remain Evolu
// implementations.

import {
  assert,
  createRelation,
  createSqlite,
  daemon,
  Name,
  ok,
  type OwnerId,
  type Task,
  tryAsync,
  Uint8Array as EvoluUint8Array,
} from "@evolu/common";
import {
  applyProtocolMessageAsRelay,
  createBaseSqliteStorageTables,
  createRelaySqliteStorage,
  createRelayStorageTables,
  defaultProtocolMessageMaxSize,
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
  readonly port?: number;
  /** Retained for deployment compatibility; Logger applies the actual level. */
  readonly enableLogging?: boolean;
}

interface LoggerDep {
  readonly logger: Logger;
}

type ReplayProtectedRelayDeps = RelayDeps & LoggerDep;

export const createReplayProtectedRelay = ({
  port = 443,
  name = Name.orThrow("evolu-relay"),
  isOwnerAllowed,
  isOwnerWithinQuota,
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

    server.on("upgrade", (request, socket, head) => {
      const onSocketError = (error: Error) => {
        relayConsole.warn("[relay]", "socket error", { error: error.message });
      };
      socket.on("error", onSocketError);

      const completeUpgrade = () => {
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
      })();
    });

    wss.on("connection", (ws) => {
      relayConsole.log("[relay]", "connection", {
        totalConnectionCount: wss.clients.size,
      });

      ws.on("error", (error) => {
        relayConsole.warn("[relay]", "socket error", { error: error.message });
      });

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
        broadcast: (ownerId, message) => {
          let broadcastCount = 0;
          for (const socket of ownerSocketRelation.iterateB(ownerId)) {
            if (socket !== ws && socket.readyState === WebSocket.OPEN) {
              socket.send(message, { binary: true });
              broadcastCount++;
            }
          }
          relayConsole.debug("[relay]", "broadcast", {
            ownerId,
            broadcastCount,
            subscriptionCount: ownerSocketRelation.bCountForA(ownerId),
          });
        },
      };

      ws.on("message", (message) => {
        if (!EvoluUint8Array.is(message)) return;
        relayConsole.debug("[relay]", "on message", {
          length: message.length,
        });

        void (async () => {
          const response = await relayRun.abortable(
            applyProtocolMessageAsRelay(message, options),
          );
          if (!response.ok) {
            if (response.error.type === "AbortError") return;
            relayConsole.error("[relay]", "applyProtocolMessageAsRelay", {
              error: response.error,
            });
            return;
          }
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
        ownerSocketRelation.removeByB(ws);
        relayConsole.log("[relay]", "close", {
          totalConnectionCount: wss.clients.size,
        });
      });
    });

    disposer.defer(() => {
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
