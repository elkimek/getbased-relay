import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { createQuotaChecker } from "../dist/lib/quota.js";
import { createMetrics } from "../dist/lib/metrics.js";
import { createOwnerTracker } from "../dist/lib/owner-tracker.js";
import { createLogger } from "../dist/lib/logger.js";
import { loadConfig } from "../dist/lib/config.js";
import { withOwnerWriteLock } from "../dist/lib/owner-write-lock.js";

const logger = { emit() {} };
const ownerId = Buffer.alloc(16, 1).toString("base64url");

test("aggregate quota includes the proposed delta, exact limits, and current usage", () => {
  let usage = { totalStoredBytes: 990, ownerStoredBytes: 0 };
  const check = createQuotaChecker({ quotaPerOwnerBytes: 2000, quotaGlobalBytes: 1000 }, logger,
    { getQuotaUsage: () => usage });
  assert.equal(check(ownerId, 100), false);
  assert.equal(check(ownerId, 10), true);
  usage = { totalStoredBytes: 990, ownerStoredBytes: 90 };
  assert.equal(check(ownerId, 100), true, "requiredBytes is the owner's new total");
  usage = { totalStoredBytes: 1000, ownerStoredBytes: 90 };
  assert.equal(check(ownerId, 100), false, "a second admission observes the latest commit");
  const ownerCheck = createQuotaChecker({ quotaPerOwnerBytes: 100, quotaGlobalBytes: 1000 }, logger,
    { getQuotaUsage: () => ({ totalStoredBytes: 0, ownerStoredBytes: 0 }) });
  assert.equal(ownerCheck(ownerId, 100), true);
  assert.equal(ownerCheck(ownerId, 101), false);
});

test("quota reads fail closed instead of treating unavailable usage as zero", () => {
  const check = createQuotaChecker({ quotaPerOwnerBytes: 100, quotaGlobalBytes: 1000 }, logger,
    { getQuotaUsage() { throw new Error("database unavailable"); } });
  assert.equal(check(ownerId, 10), false);
});

test("metrics and owner activity use the same IDs; strict quota reads expose DB failures", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-metrics-"));
  const db = new Database(join(dir, "relay.db"));
  const metrics = createMetrics({ dataDir: dir, relayName: "relay" }, logger);
  const tracker = createOwnerTracker({ dataDir: dir, ownerTtlDays: 90 }, logger);
  try {
    assert.equal(metrics.isReady(), false);
    db.exec('CREATE TABLE evolu_usage (ownerId BLOB PRIMARY KEY, storedBytes INTEGER); CREATE TABLE evolu_timestamp (t BLOB); CREATE TABLE evolu_message (timestamp BLOB); CREATE TABLE evolu_writeKey (writeKey BLOB)');
    db.prepare("INSERT INTO evolu_usage VALUES (?, ?)").run(Buffer.from(ownerId, "base64url"), 90);
    db.prepare("INSERT INTO evolu_usage VALUES (?, ?)").run(Buffer.alloc(16, 2), 900);
    tracker.trackOwner(ownerId);
    assert.ok(tracker.getActivity()[metrics.getPerOwnerUsage()[0].ownerId]);
    assert.deepEqual(metrics.getQuotaUsage(ownerId), { totalStoredBytes: 990, ownerStoredBytes: 90 });
    assert.equal(metrics.isReady(), true);
    db.exec("DROP TABLE evolu_usage");
    assert.equal(metrics.isReady(), false);
    assert.throws(() => metrics.getQuotaUsage(ownerId));
  } finally { tracker.stop(); metrics.close(); db.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("base64url aliases share the owner's write lock", async () => {
  const alias = ownerId.slice(0, -1) + "R";
  assert.deepEqual(Buffer.from(alias, "base64url"), Buffer.from(ownerId, "base64url"));
  const order = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = withOwnerWriteLock(ownerId, async () => { order.push("first"); await gate; order.push("released"); });
  const second = withOwnerWriteLock(alias, () => order.push("second"));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ["first"]);
  release(); await Promise.all([first, second]);
  assert.deepEqual(order, ["first", "released", "second"]);
});

test("upstream scoped errors keep their level and subscription tracking stays active", () => {
  const messages = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { messages.push(JSON.parse(String(chunk))); return true; };
  try {
    const log = createLogger({ logLevel: "error", logFormat: "json", enableEvoluLogging: false });
    let seen;
    log.setOwnerCallback(id => { seen = id; });
    log.console.log("[relay]", "subscribe", { ownerId });
    assert.equal(seen, ownerId);
    log.console.child("sqlite").error(new Error("write failed"));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].level, "error");
    assert.equal(messages[0].args[0].message, "write failed");
    assert.deepEqual(messages[0].scope, ["sqlite"]);
  } finally { process.stderr.write = original; }
});

test("configuration rejects truncated integers and out-of-range ports", () => {
  const original = process.env.RELAY_PORT;
  try {
    for (const value of ["4000junk", "1.5", "-1", "65536", "", "9007199254740993"]) {
      process.env.RELAY_PORT = value;
      assert.throws(loadConfig, undefined, value);
    }
  } finally {
    if (original === undefined) delete process.env.RELAY_PORT;
    else process.env.RELAY_PORT = original;
  }
});
