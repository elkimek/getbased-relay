// Health and metrics HTTP endpoints on a separate port.
// /health — unauthenticated, for uptime monitors
// /metrics — requires ADMIN_TOKEN if set, returns per-owner usage
// /compact-owner — requires ADMIN_TOKEN, drops an owner's evolu_message log
//                  and zeroes their evolu_usage.storedBytes counter so writes
//                  resume after the per-owner quota is hit. Clients keep
//                  full importedData in localStorage, so the next push from
//                  each device repopulates the owner's state.

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { timingSafeEqual } from "crypto";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import Database from "better-sqlite3";
import type { RelayConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { Metrics } from "./metrics.js";
import type { OwnerTracker } from "./owner-tracker.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"),
) as { version: string };

export function createAdminServer(
  config: RelayConfig,
  logger: Logger,
  metrics: Metrics,
  ownerTracker: OwnerTracker,
) {
  const startTime = Date.now();

  function checkAuth(req: IncomingMessage): boolean {
    if (!config.adminToken) return true;
    const provided = req.headers.authorization ?? "";
    const expected = `Bearer ${config.adminToken}`;
    if (provided.length !== expected.length) return false;
    return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  }

  // Stricter auth for mutating routes: ALWAYS require a configured ADMIN_TOKEN.
  // The default-allow behavior of checkAuth() is acceptable for read-only
  // /metrics on a localhost-bound port, but a destructive endpoint deployed
  // without a token would let any colocated process or a misconfigured
  // reverse proxy wipe an owner's CRDT log.
  function checkAuthStrict(req: IncomingMessage): boolean {
    if (!config.adminToken) return false;
    return checkAuth(req);
  }

  function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        uptime: Math.floor((Date.now() - startTime) / 1000),
        version: pkg.version,
      }),
    );
  }

  // POST /compact-owner?ownerId=<base64url-22-char>
  // Drops every evolu_message row for the given owner and resets
  // evolu_usage.storedBytes to 0. Use when an owner has hit the per-owner
  // quota: the running counter never decrements on its own (Evolu has no
  // built-in compaction), so once a long-lived owner crosses the limit
  // every push fails with quota.owner_exceeded until this is called.
  // Clients keep their full state in localStorage; the next push from each
  // device re-establishes the owner's CRDT state on the relay.
  function handleCompactOwner(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): void {
    const ownerIdStr = url.searchParams.get("ownerId");
    if (!ownerIdStr || ownerIdStr.length !== 22) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "ownerId query param required (22-char base64url Evolu OwnerId)",
        }),
      );
      return;
    }
    let ownerId: Buffer;
    try {
      ownerId = Buffer.from(ownerIdStr, "base64url");
      if (ownerId.length !== 16) throw new Error("decoded length != 16");
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: `Invalid ownerId: ${(e as Error).message}`,
        }),
      );
      return;
    }
    const dbPath = join(config.dataDir, `${config.relayName}.db`);
    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath, { fileMustExist: true });
      // Wait up to 30s for the relay's own writer to release the WAL lock
      // before failing. better-sqlite3 defaults to a 5s busy_timeout, which
      // is too short for a busy relay where the writer holds the lock during
      // a large batch ingest.
      db.pragma("busy_timeout = 30000");
      // Run the SELECTs inside the same transaction so the deletedMessages
      // count + before/after storedBytes are consistent with the DELETE/UPDATE
      // — without this, a concurrent push between the SELECT and the write
      // would yield a slightly stale count in the response.
      let before: { storedBytes: number } | undefined;
      let after: { storedBytes: number } | undefined;
      let deletedMessages = 0;
      const tx = db.transaction(() => {
        before = db!
          .prepare('SELECT "storedBytes" FROM evolu_usage WHERE "ownerId" = ?')
          .get(ownerId) as { storedBytes: number } | undefined;
        const cnt = db!
          .prepare('SELECT COUNT(*) as c FROM evolu_message WHERE "ownerId" = ?')
          .get(ownerId) as { c: number };
        deletedMessages = cnt.c;
        db!
          .prepare('DELETE FROM evolu_message WHERE "ownerId" = ?')
          .run(ownerId);
        db!
          .prepare('UPDATE evolu_usage SET "storedBytes" = 0 WHERE "ownerId" = ?')
          .run(ownerId);
        after = db!
          .prepare('SELECT "storedBytes" FROM evolu_usage WHERE "ownerId" = ?')
          .get(ownerId) as { storedBytes: number } | undefined;
      });
      tx();
      logger.emit("info", "admin.compact_owner", {
        ownerId: ownerIdStr,
        deletedMessages,
        beforeStoredBytes: before?.storedBytes ?? 0,
        afterStoredBytes: after?.storedBytes ?? 0,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          {
            ownerId: ownerIdStr,
            deletedMessages,
            beforeStoredBytes: before?.storedBytes ?? 0,
            afterStoredBytes: after?.storedBytes ?? 0,
          },
          null,
          2,
        ),
      );
    } catch (e) {
      logger.emit("warn", "admin.compact_owner_failed", {
        ownerId: ownerIdStr,
        error: (e as Error).message,
      });
      // Don't leak the raw error message (which can include the DB filesystem
      // path) over the wire — keep the detail in the structured log only.
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "compact_failed" }));
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }

  function handleMetrics(_req: IncomingMessage, res: ServerResponse): void {
    const perOwner = metrics.getPerOwnerUsage();
    const activity = ownerTracker.getActivity();
    const stale = ownerTracker.getStaleOwners();

    const owners = perOwner.map((o) => ({
      ownerId: o.ownerId.slice(0, 16) + "\u2026",
      storedBytes: o.storedBytes,
      lastSeen: activity[o.ownerId] || null,
    }));

    const body = {
      uptime: Math.floor((Date.now() - startTime) / 1000),
      version: pkg.version,
      connections: logger.getCurrentConnections(),
      owners: {
        total: metrics.getOwnerCount(),
        stale: stale.length,
        totalStoredBytes: metrics.getTotalStoredBytes(),
      },
      perOwner: owners,
      disk: { dbFileSizeBytes: metrics.getDbFileSize() },
      quota: {
        perOwnerBytes: config.quotaPerOwnerBytes,
        globalBytes: config.quotaGlobalBytes,
      },
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body, null, 2));
  }

  const server = createServer((req, res) => {
    const url = new URL(
      req.url ?? "/",
      `http://localhost:${config.adminPort}`,
    );

    if (req.method === "GET" && url.pathname === "/health") {
      return handleHealth(req, res);
    }

    if (!checkAuth(req)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/metrics") {
      return handleMetrics(req, res);
    }

    if (req.method === "POST" && url.pathname === "/compact-owner") {
      // Stricter check: destructive endpoint must NOT default-allow when
      // ADMIN_TOKEN is unset. checkAuth above would have already passed in
      // that mode, so re-gate here.
      if (!checkAuthStrict(req)) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error:
              "ADMIN_TOKEN must be configured to use this endpoint",
          }),
        );
        return;
      }
      return handleCompactOwner(req, res, url);
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.headersTimeout = 5000;
  server.requestTimeout = 10000;

  function start(): Promise<void> {
    return new Promise((resolve, reject) => {
      server.listen(config.adminPort, "127.0.0.1", () => {
        logger.emit("info", "admin.started", {
          port: config.adminPort,
          bind: "127.0.0.1",
        });
        resolve();
      });
      server.on("error", reject);
    });
  }

  function stop(): Promise<void> {
    return new Promise((resolve) => server.close(() => resolve()));
  }

  return { start, stop };
}
