// getbased-relay — Self-hosted Evolu CRDT relay
// Wraps @evolu/nodejs with structured logging, metrics, and quota management

import { mkdirSync } from "fs";
import { Name, Port, waitForAbort } from "@evolu/common";
import { installPolyfills } from "@evolu/common/polyfills";
import { createRelayDeps, runMain } from "@evolu/nodejs";
import { loadConfig } from "./lib/config.js";
import { createLogger } from "./lib/logger.js";
import { createQuotaChecker } from "./lib/quota.js";
import { createOwnerTracker } from "./lib/owner-tracker.js";
import { createMetrics } from "./lib/metrics.js";
import { createAdminServer } from "./lib/admin-server.js";
import { createSelfServer } from "./lib/self-server.js";
import { runStartupChecks } from "./lib/startup-check.js";
import { createReplayProtectedRelay } from "./lib/replay-protected-relay.js";
import { createContextVerifierServer } from "./lib/context-verifier-server.js";

installPolyfills();

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
  contextVerifier: config.contextVerifierEnabled
    ? config.contextVerifierSocket ?? `${config.contextVerifierBind}:${config.contextVerifierPort}`
    : null,
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

// runMain owns the root Run, signal handling, and fatal defect exit status.
// Returning from waitForAbort disposes every HTTP surface and relay resource.
await runMain({ ...createRelayDeps(), console: logger.console, logger })(async (run) => {
  await using disposer = new AsyncDisposableStack();
  disposer.defer(() => logger.emit("info", "relay.stopped"));
  const metrics = createMetrics(config, logger);
  disposer.defer(() => metrics.close());
  const ownerTracker = createOwnerTracker(config, logger);
  disposer.defer(() => ownerTracker.stop());
  logger.setOwnerCallback((ownerId) => ownerTracker.trackOwner(ownerId));

  const relay = disposer.use(await run.ok(createReplayProtectedRelay({
    port: Port.orThrow(config.relayPort),
    name: Name.orThrow(config.relayName),
    enableLogging: config.enableEvoluLogging,
    isOwnerWithinQuota: createQuotaChecker(config, logger, metrics),
  })));
  const admin = disposer.adopt(
    createAdminServer(config, logger, metrics, ownerTracker,
      () => !run.signal.aborted && metrics.isReady()),
    (server) => server.stop(),
  );
  await admin.start();
  if (config.selfEnabled) {
    const self = disposer.adopt(createSelfServer(config, logger), (server) => server.stop());
    await self.start();
  }
  if (config.contextVerifierEnabled) {
    const verifier = disposer.adopt(createContextVerifierServer(config, logger), (server) => server.stop());
    await verifier.start();
  }

  logger.emit("info", "relay.ready", {
    relay: `ws://0.0.0.0:${relay.port}`,
    admin: `http://127.0.0.1:${config.adminPort}`,
    self: config.selfEnabled ? `http://${config.selfBind}:${config.selfPort}` : null,
    contextVerifier: config.contextVerifierEnabled
      ? config.contextVerifierSocket ?? `http://${config.contextVerifierBind}:${config.contextVerifierPort}`
      : null,
  });
  run.signal.addEventListener("abort", () => {
    logger.emit("info", "relay.shutting_down", { reason: run.signal.reason });
  }, { once: true });
  return await run(waitForAbort);
});
