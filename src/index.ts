// getbased-relay — Self-hosted Evolu CRDT relay
// Wraps @evolu/nodejs with structured logging, metrics, and quota management

import { mkdirSync } from "fs";
import { createNodeJsRelay } from "@evolu/nodejs";
import { SimpleName } from "@evolu/common";
import { loadConfig } from "./lib/config.js";
import { createLogger } from "./lib/logger.js";
import { createQuotaChecker } from "./lib/quota.js";
import { createOwnerTracker } from "./lib/owner-tracker.js";
import { createMetrics } from "./lib/metrics.js";
import { createAdminServer } from "./lib/admin-server.js";
import { createSelfServer } from "./lib/self-server.js";
import { runStartupChecks } from "./lib/startup-check.js";

// ─── Config ────────────────────────────────────────────
const config = loadConfig();
const logger = createLogger(config);

logger.emit("info", "relay.config", {
  relayPort: config.relayPort,
  adminPort: config.adminPort,
  selfPort: config.selfEnabled ? config.selfPort : null,
  selfBind: config.selfEnabled ? config.selfBind : null,
  dataDir: config.dataDir,
  quotaPerOwnerMB: config.quotaPerOwnerBytes / (1024 * 1024),
  quotaGlobalMB: config.quotaGlobalBytes / (1024 * 1024),
  ownerTtlDays: config.ownerTtlDays,
  logLevel: config.logLevel,
  adminAuth: config.adminToken ? "token" : "open",
});

// ─── Data directory ────────────────────────────────────
mkdirSync(config.dataDir, { recursive: true });
process.chdir(config.dataDir);

// ─── Startup checks ───────────────────────────────────
const check = runStartupChecks(config, logger);
if (!check.ok) {
  logger.emit("error", "relay.startup_failed", { error: check.error });
  process.exit(1);
}

// ─── Metrics (read-only DB access) ────────────────────
const metrics = createMetrics(config, logger);

// ─── Owner tracker ────────────────────────────────────
const ownerTracker = createOwnerTracker(config, logger);

// ─── Quota checker ────────────────────────────────────
const isOwnerWithinQuota = createQuotaChecker(config, logger, metrics);

// Wire owner tracking through logger subscribe events
logger.setOwnerCallback((ownerId: string) =>
  ownerTracker.trackOwner(ownerId),
);

// ─── Evolu relay ──────────────────────────────────────
// Evolu's Console type is not publicly exported — cast required.
// Our console implements the full interface (log/warn/error/debug + enabled property).
const relay = await createNodeJsRelay({
  console: logger.console as never,
})({
  port: config.relayPort,
  name: SimpleName.orThrow(config.relayName),
  enableLogging: config.enableEvoluLogging,
  isOwnerWithinQuota,
});

if (!relay.ok) {
  logger.emit("error", "relay.failed", { error: relay.error as unknown as Record<string, unknown> });
  process.exit(1);
}

// ─── Admin server ─────────────────────────────────────
const admin = createAdminServer(config, logger, metrics, ownerTracker);
await admin.start();

// ─── Self-service server (HMAC-authed, owner-scoped) ──
const self = config.selfEnabled ? createSelfServer(config, logger) : null;
if (self) await self.start();

logger.emit("info", "relay.ready", {
  relay: `ws://0.0.0.0:${config.relayPort}`,
  admin: `http://127.0.0.1:${config.adminPort}`,
  self: self ? `http://${config.selfBind}:${config.selfPort}` : null,
});

// ─── Graceful shutdown ────────────────────────────────
let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.emit("info", "relay.shutting_down", { signal });

  ownerTracker.stop();
  metrics.close();
  try {
    if ("value" in relay) relay.value[Symbol.dispose]();
  } catch (e) {
    logger.emit("warn", "relay.dispose_error", { error: (e as Error).message });
  }
  await admin.stop();
  if (self) await self.stop();

  logger.emit("info", "relay.stopped");
  process.exit(0);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
