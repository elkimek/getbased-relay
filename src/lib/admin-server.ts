// Health and metrics HTTP endpoints on a separate port.
// /health — unauthenticated, for uptime monitors
// /metrics — requires ADMIN_TOKEN if set, returns per-owner usage

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
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
    return req.headers.authorization === `Bearer ${config.adminToken}`;
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
