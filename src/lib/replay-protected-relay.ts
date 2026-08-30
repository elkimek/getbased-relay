// Evolu's Node relay does not currently expose a storage-decorator hook. This
// module mirrors its small Node/WebSocket adapter so we can put the compaction
// replay guard directly around the upstream SQLite storage. Protocol parsing,
// reconciliation, encryption, and persistence remain Evolu implementations.

import {
  createRandom,
  createRelation,
  createSqlite,
  isAsync,
  ok,
  SimpleName,
  Uint8Array as EvoluUint8Array,
  type ConsoleDep,
  type OwnerId,
  type Result,
  type SqliteError,
} from "@evolu/common";
import {
  applyProtocolMessageAsRelay,
  createBaseSqliteStorageTables,
  createRelayLogger,
  createRelaySqliteStorage,
  createRelayStorageTables,
  defaultProtocolMessageMaxSize,
  parseOwnerIdFromOwnerWebSocketTransportUrl,
  type ApplyProtocolMessageAsRelayOptions,
  type Relay,
  type RelayConfig,
} from "@evolu/common/local-first";
import { createBetterSqliteDriver } from "@evolu/nodejs";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { createCompactionReplayGuard } from "./compaction-replay.js";
import type { Logger } from "./logger.js";

export interface ReplayProtectedRelayConfig extends RelayConfig {
  readonly port?: number;
}

interface ReplayProtectedRelayDeps extends ConsoleDep {
  readonly logger: Logger;
}

export const createReplayProtectedRelay =
  (deps: ReplayProtectedRelayDeps) =>
  async ({
    port = 443,
    name = SimpleName.orThrow("evolu-relay"),
    enableLogging = false,
    isOwnerAllowed,
    isOwnerWithinQuota,
  }: ReplayProtectedRelayConfig): Promise<Result<Relay, SqliteError>> => {
    const log = createRelayLogger(deps);
    log.started(enableLogging, port);

    const dbPath = resolve(`${name}.db`);
    const dbFileExists = existsSync(dbPath);
    const sqlite = await createSqlite({
      createSqliteDriver: createBetterSqliteDriver,
    })(name);
    if (!sqlite.ok) return sqlite;

    const sqliteDeps = { sqlite: sqlite.value };
    if (!dbFileExists) {
      const baseTables = createBaseSqliteStorageTables(sqliteDeps);
      if (!baseTables.ok) return baseTables;
      const relayTables = createRelayStorageTables(sqliteDeps);
      if (!relayTables.ok) return relayTables;
    }

    const baseStorage = createRelaySqliteStorage({
      random: createRandom(),
      sqlite: sqlite.value,
      timingSafeEqual,
    })({
      onStorageError: log.storageError,
      isOwnerWithinQuota,
    });
    const replayGuard = createCompactionReplayGuard(
      dbPath,
      baseStorage,
      deps.logger,
    );
    const storage = replayGuard.storage;

    const server = createServer();
    const wss = new WebSocketServer({
      maxPayload: defaultProtocolMessageMaxSize,
      noServer: true,
    });
    const ownerSocketRelation = createRelation<OwnerId, WebSocket>();

    server.on("upgrade", (request, socket, head) => {
      socket.on("error", log.upgradeSocketError);

      const completeUpgrade = () => {
        socket.removeListener("error", log.upgradeSocketError);
        wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
          wss.emit("connection", ws, request);
        });
      };

      if (!isOwnerAllowed) {
        completeUpgrade();
        return;
      }

      const ownerId = parseOwnerIdFromOwnerWebSocketTransportUrl(
        request.url ?? "",
      );
      if (!ownerId) {
        log.invalidOrMissingOwnerIdInUrl(request.url);
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }

      void (async () => {
        const result = isOwnerAllowed(ownerId);
        const isAllowed = isAsync(result) ? await result : result;
        if (!isAllowed) {
          log.unauthorizedOwner(ownerId);
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        completeUpgrade();
      })();
    });

    wss.on("connection", (ws: WebSocket) => {
      log.connectionEstablished(wss.clients.size);

      ws.on("error", (error: Error) => {
        log.connectionWebSocketError(error);
      });

      const options: ApplyProtocolMessageAsRelayOptions = {
        subscribe: (ownerId) => {
          ownerSocketRelation.add(ownerId, ws);
          log.relayOptionSubscribe(
            ownerId,
            () => ownerSocketRelation.getB(ownerId)?.size ?? 0,
          );
        },
        unsubscribe: (ownerId) => {
          ownerSocketRelation.remove(ownerId, ws);
          log.relayOptionUnsubscribe(
            ownerId,
            () => ownerSocketRelation.getB(ownerId)?.size ?? 0,
          );
        },
        broadcast: (ownerId, message) => {
          const sockets = ownerSocketRelation.getB(ownerId);
          if (!sockets) return;
          let broadcastCount = 0;
          for (const socket of sockets) {
            if (socket !== ws && socket.readyState === WebSocket.OPEN) {
              socket.send(message, { binary: true });
              broadcastCount++;
            }
          }
          log.relayOptionBroadcast(ownerId, broadcastCount, sockets.size);
        },
      };

      ws.on("message", (message: unknown) => {
        if (!EvoluUint8Array.is(message)) return;
        log.messageLength(message.length);
        applyProtocolMessageAsRelay({ storage })(message, options)
          .then((response) => {
            if (!response.ok) {
              log.applyProtocolMessageAsRelayError(response.error);
              return;
            }
            ws.send(response.value.message, { binary: true });
            log.responseLength(response.value.message.length);
          })
          .catch(log.applyProtocolMessageAsRelayUnknownError);
      });

      ws.on("close", () => {
        ownerSocketRelation.deleteB(ws);
        log.connectionClosed(wss.clients.size);
      });
    });

    server.listen(port);

    let isDisposed = false;
    const relay: Relay = {
      [Symbol.dispose]: () => {
        if (isDisposed) return;
        isDisposed = true;
        log.shuttingDown();
        wss.clients.forEach((client: WebSocket) => {
          if (client.readyState === WebSocket.OPEN) {
            client.close(1000, "Evolu Relay shutting down");
          }
        });
        wss.close(() => log.webSocketServerDisposed());
        server.close(() => log.httpServerDisposed());
        replayGuard[Symbol.dispose]();
        sqlite.value[Symbol.dispose]();
      },
    };

    return ok(relay);
  };
