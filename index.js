// getbased-relay — Self-hosted Evolu CRDT relay
// Wraps @evolu/nodejs with structured logging, metrics, and quota management

import { mkdirSync } from 'fs';
import { createNodeJsRelay } from '@evolu/nodejs';
import { loadConfig } from './lib/config.js';
import { createLogger } from './lib/logger.js';
import { createQuotaChecker } from './lib/quota.js';
import { createOwnerTracker } from './lib/owner-tracker.js';
import { createMetrics } from './lib/metrics.js';
import { createAdminServer } from './lib/admin-server.js';
import { runStartupChecks } from './lib/startup-check.js';

// ─── Config ────────────────────────────────────────────
const config = loadConfig();
const logger = createLogger(config);

logger.emit('info', 'relay.config', {
  relayPort: config.relayPort,
  adminPort: config.adminPort,
  dataDir: config.dataDir,
  quotaPerOwnerMB: config.quotaPerOwnerBytes / (1024 * 1024),
  quotaGlobalMB: config.quotaGlobalBytes / (1024 * 1024),
  ownerTtlDays: config.ownerTtlDays,
  logLevel: config.logLevel,
  adminAuth: config.adminToken ? 'token' : 'open',
});

// ─── Data directory ────────────────────────────────────
mkdirSync(config.dataDir, { recursive: true });
process.chdir(config.dataDir);

// ─── Startup checks ───────────────────────────────────
const check = runStartupChecks(config, logger);
if (!check.ok) {
  logger.emit('error', 'relay.startup_failed', { error: check.error });
  process.exit(1);
}

// ─── Metrics (read-only DB access) ────────────────────
const metrics = createMetrics(config, logger);

// ─── Owner tracker ────────────────────────────────────
const ownerTracker = createOwnerTracker(config, logger);

// ─── Quota checker ────────────────────────────────────
const isOwnerWithinQuota = createQuotaChecker(config, logger, metrics);

// ─── Evolu relay ──────────────────────────────────────
const { SimpleName } = await import('@evolu/common');

const relay = await createNodeJsRelay({
  console: logger.console,
})({
  port: config.relayPort,
  name: SimpleName.orThrow(config.relayName),
  // When enableEvoluLogging is true, Evolu sets console.enabled = true after startup.
  // Our custom Console always has enabled=true and filters by LOG_LEVEL,
  // but Evolu's logger toggles it. Pass through the user's preference.
  enableLogging: config.enableEvoluLogging,
  isOwnerAllowed: ownerTracker.isOwnerAllowed,
  isOwnerWithinQuota,
});

if (!relay.ok) {
  logger.emit('error', 'relay.failed', { error: relay.error });
  process.exit(1);
}

// ─── Admin server ─────────────────────────────────────
const admin = createAdminServer(config, logger, metrics, ownerTracker);
await admin.start();

logger.emit('info', 'relay.ready', {
  relay: `ws://0.0.0.0:${config.relayPort}`,
  admin: `http://127.0.0.1:${config.adminPort}`,
});

// ─── Graceful shutdown ────────────────────────────────
let isShuttingDown = false;

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.emit('info', 'relay.shutting_down', { signal });

  ownerTracker.stop();
  metrics.close();
  try { relay.value[Symbol.dispose](); } catch {}
  await admin.stop();

  logger.emit('info', 'relay.stopped', {});
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
