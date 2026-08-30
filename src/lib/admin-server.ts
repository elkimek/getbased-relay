// Health and metrics HTTP endpoints on a separate port.
// /health — unauthenticated, for uptime monitors
// /metrics — requires ADMIN_TOKEN if set, returns per-owner usage
// /compact-owner — requires ADMIN_TOKEN, replaces an owner's evolu_message log
//                  with exact replay tombstones and clears live usage so
//                  writes resume after quota. Stale paired devices may safely
//                  reconnect after one client rebuilds a fresh snapshot.

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
import { compactOwner } from "./compact-owner.js";
import { withOwnerWriteLock } from "./owner-write-lock.js";

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
  // Drops every evolu_message row for the given owner and removes its
  // evolu_usage row. Use when an owner has hit the per-owner
  // quota: the running counter never decrements on its own (Evolu has no
  // built-in compaction), so once a long-lived owner crosses the limit
  // every push fails with quota.owner_exceeded until this is called.
  // Deleted message timestamps become replay tombstones, so a stale paired
  // client cannot upload the discarded encrypted history again.
  async function handleCompactOwner(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> {
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
    try {
      const result = await withOwnerWriteLock(ownerIdStr, () => {
        const db = new Database(dbPath, { fileMustExist: true });
        try {
          // Wait up to 30s for unrelated SQLite writers. Same-owner relay
          // writes are also serialized by the outer owner lock.
          db.pragma("busy_timeout = 30000");
          return compactOwner(db, ownerId);
        } finally {
          db.close();
        }
      });
      logger.emit("info", "admin.compact_owner", {
        ownerId: ownerIdStr,
        ...result,
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ownerId: ownerIdStr, ...result }, null, 2));
    } catch (e) {
      logger.emit("warn", "admin.compact_owner_failed", {
        ownerId: ownerIdStr,
        error: (e as Error).message,
      });
      // Don't leak the raw error message (which can include the DB filesystem
      // path) over the wire — keep the detail in the structured log only.
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "compact_failed" }));
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
      void handleCompactOwner(req, res, url);
      return;
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
