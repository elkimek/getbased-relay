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
