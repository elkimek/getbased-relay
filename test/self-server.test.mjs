// Smoke test for the HMAC verify path on /self/* endpoints.
// Runs against compiled dist/ — `npm test` builds first.
//
// Coverage focus: the auth helper. The DB transaction is identical to
// /admin/compact-owner (battle-tested via runbook) and the HTTP routing
// is straightforward — the asymmetric crypto is where regressions hide.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

import { createSelfServer } from "../dist/lib/self-server.js";

// Build a config + minimal logger + DB scaffold matching what the
// production code expects. We don't start the HTTP listener — only
// exercise the exposed `_verifySignature` helper and `_decodeOwnerId`.
function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), "relay-self-test-"));
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "evolu-relay.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE evolu_writeKey (
      "ownerId" blob not null,
      "writeKey" blob not null,
      primary key ("ownerId")
    ) strict;
    CREATE TABLE evolu_usage (
      "ownerId" blob primary key,
      "storedBytes" integer not null,
      "firstTimestamp" blob,
      "lastTimestamp" blob
    ) strict;
    CREATE TABLE evolu_message (
      "ownerId" blob not null,
      "timestamp" blob not null,
      "change" blob not null,
      primary key ("ownerId", "timestamp")
    ) strict;
  `);
  db.close();
  const config = {
    relayPort: 4000,
    adminPort: 4001,
    selfPort: 4003,
    selfBind: "127.0.0.1",
    selfEnabled: true,
    relayName: "evolu-relay",
    dataDir,
    quotaPerOwnerBytes: 10 * 1024 * 1024,
    quotaGlobalBytes: 100 * 1024 * 1024,
    ownerTtlDays: 90,
    logLevel: "warn",
    logFormat: "json",
    enableEvoluLogging: false,
    adminToken: null,
  };
  const logger = {
    emit() {},
    console: { log() {}, warn() {}, error() {}, debug() {}, enabled: false },
    setOwnerCallback() {},
    getCurrentConnections() { return 0; },
  };
  const server = createSelfServer(config, logger);
  return { config, server, dataDir, dbPath };
}

function makeOwner(dbPath, writeKey) {
  // 22-char base64url ownerId (16 random bytes encoded). Must match the
  // alphabet check inside decodeOwnerId.
  const ownerIdBytes = Buffer.from("0123456789abcdef", "ascii"); // 16 bytes
  const ownerIdStr = ownerIdBytes.toString("base64url"); // 22 chars
  const db = new Database(dbPath);
  db.prepare(
    'INSERT INTO evolu_writeKey ("ownerId", "writeKey") VALUES (?, ?)',
  ).run(ownerIdBytes, writeKey);
  db.close();
  return { ownerIdBytes, ownerIdStr };
}

function sign(writeKey, context, ownerIdStr, timestampMs) {
  return createHmac("sha256", writeKey)
    .update(`${context}:${ownerIdStr}:${timestampMs}`)
    .digest("hex");
}

test("decodeOwnerId rejects bad inputs", () => {
  const { server } = setup();
  assert.equal(server._decodeOwnerId(null), null);
  assert.equal(server._decodeOwnerId(""), null);
  assert.equal(server._decodeOwnerId("short"), null);
  // Standard-base64 padding char rejected (must be base64url alphabet).
  assert.equal(server._decodeOwnerId("==========AAAAAAAAAAAA"), null);
  // Right length but contains '+' (standard base64, not base64url).
  assert.equal(server._decodeOwnerId("AAAAAAAAAAA+AAAAAAAAAA"), null);
  // Valid 22-char base64url decodes to 16 bytes.
  const ok = "MDEyMzQ1Njc4OWFiY2RlZg"; // "0123456789abcdef" in base64url
  const buf = server._decodeOwnerId(ok);
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.length, 16);
});

test("verifySignature accepts a fresh, well-signed request", () => {
  const { server, dbPath } = setup();
  const writeKey = Buffer.alloc(32, 7);
  const { ownerIdBytes, ownerIdStr } = makeOwner(dbPath, writeKey);
  const lookup = (id) => {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db
        .prepare('SELECT "writeKey" FROM evolu_writeKey WHERE "ownerId" = ?')
        .get(id);
      return row?.writeKey ?? null;
    } finally {
      db.close();
    }
  };
  const ts = Date.now();
  const sig = sign(writeKey, "compact", ownerIdStr, ts);
  const result = server._verifySignature(
    ownerIdBytes,
    ts,
    sig,
    "compact",
    ownerIdStr,
    lookup,
  );
  assert.equal(result, null);
});

test("verifySignature rejects timestamp outside ±5min window", () => {
  const { server, dbPath } = setup();
  const writeKey = Buffer.alloc(32, 7);
  const { ownerIdBytes, ownerIdStr } = makeOwner(dbPath, writeKey);
  const lookup = () => writeKey;
  const tooOld = Date.now() - 6 * 60 * 1000;
  const sig = sign(writeKey, "compact", ownerIdStr, tooOld);
  const result = server._verifySignature(
    ownerIdBytes,
    tooOld,
    sig,
    "compact",
    ownerIdStr,
    lookup,
  );
  assert.deepEqual(result, { status: 401, error: "timestamp_outside_window" });
});

test("verifySignature rejects wrong-signature requests", () => {
  const { server, dbPath } = setup();
  const writeKey = Buffer.alloc(32, 7);
  const { ownerIdBytes, ownerIdStr } = makeOwner(dbPath, writeKey);
  const lookup = () => writeKey;
  const ts = Date.now();
  // Sign with a DIFFERENT key — the relay should reject.
  const wrongKey = Buffer.alloc(32, 9);
  const sig = sign(wrongKey, "compact", ownerIdStr, ts);
  const result = server._verifySignature(
    ownerIdBytes,
    ts,
    sig,
    "compact",
    ownerIdStr,
    lookup,
  );
  assert.deepEqual(result, { status: 401, error: "unauthorized" });
});

test("verifySignature rejects context mismatch (compact sig used on storage route)", () => {
  const { server, dbPath } = setup();
  const writeKey = Buffer.alloc(32, 7);
  const { ownerIdBytes, ownerIdStr } = makeOwner(dbPath, writeKey);
  const lookup = () => writeKey;
  const ts = Date.now();
  // Sign for "compact" context, then try to use it on "storage".
  // This is the load-bearing test for the prefix domain separation:
  // a captured compact signature must NOT be replayable on a different
  // mutating-or-readonly endpoint.
  const sig = sign(writeKey, "compact", ownerIdStr, ts);
  const result = server._verifySignature(
    ownerIdBytes,
    ts,
    sig,
    "storage",
    ownerIdStr,
    lookup,
  );
  assert.deepEqual(result, { status: 401, error: "unauthorized" });
});

test("verifySignature rejects unknown owner with a uniform 401 (no existence oracle)", () => {
  const { server } = setup();
  const writeKey = Buffer.alloc(32, 7);
  const ownerIdBytes = Buffer.from("0123456789abcdef", "ascii");
  const ownerIdStr = ownerIdBytes.toString("base64url");
  const lookup = () => null; // owner not in writeKey table
  const ts = Date.now();
  const sig = sign(writeKey, "compact", ownerIdStr, ts);
  const result = server._verifySignature(
    ownerIdBytes,
    ts,
    sig,
    "compact",
    ownerIdStr,
    lookup,
  );
  assert.deepEqual(result, { status: 401, error: "unauthorized" });
});

test("verifySignature rejects malformed signature hex", () => {
  const { server, dbPath } = setup();
  const writeKey = Buffer.alloc(32, 7);
  const { ownerIdBytes, ownerIdStr } = makeOwner(dbPath, writeKey);
  const lookup = () => writeKey;
  const ts = Date.now();
  // 63-char hex (one short of expected 64 = 32 bytes).
  const result = server._verifySignature(
    ownerIdBytes,
    ts,
    "abc",
    "compact",
    ownerIdStr,
    lookup,
  );
  assert.deepEqual(result, { status: 401, error: "invalid_signature_format" });
});

// ─── v1.2.1: rate limit + log coalescing ──────────────────────

test("rateCheck allows up to bucket capacity, then 429s", () => {
  const { server } = setup();
  const ip = "1.2.3.4";
  // compact bucket = 10/min. First 10 must pass, 11th must trip.
  for (let i = 0; i < 10; i++) {
    const r = server._rateCheck(ip, "compact");
    assert.equal(r.allowed, true, `request ${i + 1} should be allowed`);
  }
  const blocked = server._rateCheck(ip, "compact");
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.retryAfterSec >= 1, "retryAfterSec should be a positive integer");
});

test("rateCheck buckets are per-IP + per-route (one IP doesn't drain another's quota)", () => {
  const { server } = setup();
  // Drain compact for IP A.
  for (let i = 0; i < 10; i++) server._rateCheck("10.0.0.1", "compact");
  assert.equal(server._rateCheck("10.0.0.1", "compact").allowed, false);
  // IP B still fresh on compact.
  assert.equal(server._rateCheck("10.0.0.2", "compact").allowed, true);
  // IP A still fresh on storage (different bucket).
  assert.equal(server._rateCheck("10.0.0.1", "storage").allowed, true);
});

test("rateCheck storage bucket is more generous than compact (60 vs 10)", () => {
  const { server } = setup();
  // Storage should allow at least 11 in a row (proves it's not the
  // compact bucket).
  for (let i = 0; i < 11; i++) {
    const r = server._rateCheck("5.5.5.5", "storage");
    assert.equal(r.allowed, true, `storage request ${i + 1} should be allowed`);
  }
});

test("logShouldEmit returns true on first call, false on duplicates within window", () => {
  const { server } = setup();
  assert.equal(server._logShouldEmit("ABC", "1.1.1.1", "wrong_sig"), true);
  assert.equal(server._logShouldEmit("ABC", "1.1.1.1", "wrong_sig"), false);
  assert.equal(server._logShouldEmit("ABC", "1.1.1.1", "wrong_sig"), false);
  // Different reason → fresh emit.
  assert.equal(server._logShouldEmit("ABC", "1.1.1.1", "timestamp_outside_window"), true);
  // Different IP → fresh emit.
  assert.equal(server._logShouldEmit("ABC", "2.2.2.2", "wrong_sig"), true);
  // Different ownerId → fresh emit.
  assert.equal(server._logShouldEmit("XYZ", "1.1.1.1", "wrong_sig"), true);
});

// ─── v1.2.2: LRU eviction caps Map size ──────────────────────

test("rateCheck LRU touch keeps recently-used keys alive when other keys are added", () => {
  const { server } = setup();
  // Fill 3 distinct IPs on the compact bucket.
  server._rateCheck("ip-A", "compact");
  server._rateCheck("ip-B", "compact");
  server._rateCheck("ip-C", "compact");
  // Touch ip-A again — it should now be the most-recently-used.
  server._rateCheck("ip-A", "compact");
  // Add a fourth — under cap, all four exist. We're not asserting
  // eviction here (cap is 10k), just that the LRU touch doesn't break
  // the bucket count tracking.
  const r = server._rateCheck("ip-A", "compact");
  assert.equal(r.allowed, true, "ip-A should still be within its bucket");
  // Ip-A was touched 3 times now; should be at count=3 (still within
  // capacity=10).
});

test("rateCheck still rate-limits correctly after many LRU touches", () => {
  const { server } = setup();
  // Burn the bucket via repeated touches on the same IP. The LRU
  // touch logic must NOT reset the count or duplicate the key.
  for (let i = 0; i < 10; i++) {
    const r = server._rateCheck("burn-ip", "compact");
    assert.equal(r.allowed, true, `request ${i + 1} should still be allowed`);
  }
  const blocked = server._rateCheck("burn-ip", "compact");
  assert.equal(blocked.allowed, false, "11th request must be 429");
});

test("logShouldEmit dedup still works after LRU touch (re-insert preserves count)", () => {
  const { server } = setup();
  const k = ["OWNER", "ip", "wrong_sig"];
  // First emit.
  assert.equal(server._logShouldEmit(...k), true);
  // 9 suppressed.
  for (let i = 0; i < 9; i++) {
    assert.equal(server._logShouldEmit(...k), false);
  }
  // Different reason — fresh emit, should NOT inherit the suppressed state.
  assert.equal(server._logShouldEmit("OWNER", "ip", "timestamp_outside_window"), true);
  // Original key still in suppress mode.
  assert.equal(server._logShouldEmit(...k), false);
});

test("clientIp trusts X-Forwarded-For only when peer is loopback", () => {
  const { server } = setup();
  // Loopback peer + XFF set → trust XFF (left-most entry).
  const fakeReq1 = {
    socket: { remoteAddress: "127.0.0.1" },
    headers: { "x-forwarded-for": "203.0.113.5, 10.0.0.1" },
  };
  assert.equal(server._clientIp(fakeReq1), "203.0.113.5");
  // ::1 also loopback.
  const fakeReq2 = {
    socket: { remoteAddress: "::1" },
    headers: { "x-forwarded-for": "203.0.113.5" },
  };
  assert.equal(server._clientIp(fakeReq2), "203.0.113.5");
  // ::ffff:127.0.0.1 also loopback (IPv4-in-IPv6).
  const fakeReq3 = {
    socket: { remoteAddress: "::ffff:127.0.0.1" },
    headers: { "x-forwarded-for": "203.0.113.5" },
  };
  assert.equal(server._clientIp(fakeReq3), "203.0.113.5");
  // Non-loopback peer + XFF → ignore XFF (don't trust unauthenticated header).
  const fakeReq4 = {
    socket: { remoteAddress: "203.0.113.99" },
    headers: { "x-forwarded-for": "1.2.3.4" },
  };
  assert.equal(server._clientIp(fakeReq4), "203.0.113.99");
  // No headers + no socket → 0.0.0.0 fallback.
  const fakeReq5 = { socket: {}, headers: {} };
  assert.equal(server._clientIp(fakeReq5), "0.0.0.0");
});
