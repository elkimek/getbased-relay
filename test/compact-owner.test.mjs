// Unit test for the shared compactOwner helper. Both /admin/compact-owner
// and /self/compact-owner call this function — testing it directly means
// either route's coverage is automatic by construction.
//
// The self-server integration test (self-server.integration.test.mjs)
// exercises the same helper end-to-end via the HTTP path. This file
// covers the helper's contract in isolation: schema cleanup happens,
// before/after counts are correct, idempotent on already-empty owners,
// other owners' state is untouched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { createRandom, createSqlite, SimpleName } from "@evolu/common";
import {
  createBaseSqliteStorageTables,
  createRelaySqliteStorage,
  createRelayStorageTables,
} from "@evolu/common/local-first";
import { createBetterSqliteDriver } from "@evolu/nodejs";

import { compactOwner } from "../dist/lib/compact-owner.js";

function setup() {
  const dbPath = join(mkdtempSync(join(tmpdir(), "compact-owner-test-")), "relay.db");
  const db = new Database(dbPath);
  db.exec(`
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
    CREATE TABLE evolu_timestamp (
      "ownerId" blob not null,
      "t" blob not null,
      "h1" integer, "h2" integer, "c" integer,
      "l" integer not null,
      primary key ("ownerId", "t")
    ) strict;
  `);
  return { db };
}

function seedOwner(db, ownerIdBytes, { messageCount = 5, payloadBytes = 1000 } = {}) {
  db.prepare('INSERT INTO evolu_usage ("ownerId", "storedBytes", "firstTimestamp", "lastTimestamp") VALUES (?, ?, ?, ?)')
    .run(ownerIdBytes, messageCount * payloadBytes,
         Buffer.from("ts-0", "utf8"), Buffer.from(`ts-${messageCount - 1}`, "utf8"));
  const insertMsg = db.prepare('INSERT INTO evolu_message ("ownerId", "timestamp", "change") VALUES (?, ?, ?)');
  const insertTs = db.prepare('INSERT INTO evolu_timestamp ("ownerId", "t", "h1", "h2", "c", "l") VALUES (?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < messageCount; i++) {
    const ts = Buffer.from(`ts-${i}`, "utf8");
    insertMsg.run(ownerIdBytes, ts, Buffer.alloc(payloadBytes));
    insertTs.run(ownerIdBytes, ts, 0, 0, 0, 1);
  }
}

async function openRealRelayStorage(dataDir, fresh) {
  const createSqliteDriver = (name, options) => {
    const previousCwd = process.cwd();
    try {
      process.chdir(dataDir);
      return createBetterSqliteDriver(name, options);
    } finally {
      process.chdir(previousCwd);
    }
  };
  const opened = await createSqlite({ createSqliteDriver })(
    SimpleName.orThrow("compact-owner-relay-test"),
  );
  assert.equal(opened.ok, true, "real Evolu SQLite storage should open");
  const sqlite = opened.value;
  if (fresh) {
    const baseTables = createBaseSqliteStorageTables({ sqlite });
    assert.equal(baseTables.ok, true, "base Evolu tables should be created");
    const relayTables = createRelayStorageTables({ sqlite });
    assert.equal(relayTables.ok, true, "relay Evolu tables should be created");
  }
  const storageErrors = [];
  const storage = createRelaySqliteStorage({
    random: createRandom(),
    sqlite,
    timingSafeEqual: (a, b) => Buffer.from(a).equals(Buffer.from(b)),
  })({
    onStorageError: (error) => storageErrors.push(error),
    isOwnerWithinQuota: () => true,
  });
  return { sqlite, storage, storageErrors };
}

test("compactOwner deletes evolu_message rows for the target owner", () => {
  const { db } = setup();
  const ownerIdBytes = randomBytes(16);
  seedOwner(db, ownerIdBytes);

  const result = compactOwner(db, ownerIdBytes);

  assert.equal(result.deletedMessages, 5);
  const after = db.prepare('SELECT COUNT(*) as c FROM evolu_message WHERE "ownerId" = ?').get(ownerIdBytes);
  assert.equal(after.c, 0);
});

test("compactOwner deletes evolu_timestamp rows (the merkle/fingerprint table)", () => {
  // This is the regression guard for the production wedge: pre-fix,
  // these rows survived compact, fed stale fingerprints to the negentropy
  // reconciliation, and stranded every subsequent peer push.
  const { db } = setup();
  const ownerIdBytes = randomBytes(16);
  seedOwner(db, ownerIdBytes);

  const before = db.prepare('SELECT COUNT(*) as c FROM evolu_timestamp WHERE "ownerId" = ?').get(ownerIdBytes);
  assert.equal(before.c, 5, "fixture sanity");

  compactOwner(db, ownerIdBytes);

  const after = db.prepare('SELECT COUNT(*) as c FROM evolu_timestamp WHERE "ownerId" = ?').get(ownerIdBytes);
  assert.equal(after.c, 0, "evolu_timestamp must be empty post-compact (else fresh pushes get stranded)");
});

test("compactOwner deletes evolu_usage so the next write takes the fresh-owner path", () => {
  const { db } = setup();
  const ownerIdBytes = randomBytes(16);
  seedOwner(db, ownerIdBytes);

  const result = compactOwner(db, ownerIdBytes);

  assert.equal(result.beforeStoredBytes, 5000);
  assert.equal(result.afterStoredBytes, 0);
  const usage = db.prepare('SELECT * FROM evolu_usage WHERE "ownerId" = ?').get(ownerIdBytes);
  assert.equal(usage, undefined, "an existing NULL-timestamp row makes Evolu reject rebuild writes");
});

test("the real Evolu relay accepts a fresh write after compaction", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "compact-owner-real-relay-"));
  const dbPath = join(dataDir, "compact-owner-relay-test.db");
  const ownerIdBytes = randomBytes(16);
  const oldMessage = {
    timestamp: { millis: 1_000, counter: 0, nodeId: "0011223344556677" },
    change: Buffer.alloc(80),
  };
  const initial = await openRealRelayStorage(dataDir, true);
  const initialWrite = await initial.storage.writeMessages(ownerIdBytes, [oldMessage]);
  assert.equal(initialWrite.ok, true, "fixture write should succeed through Evolu storage");
  assert.deepEqual(initial.storageErrors, []);
  initial.sqlite[Symbol.dispose]();

  const db = new Database(dbPath);
  compactOwner(db, ownerIdBytes);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name LIKE 'evolu_%compaction%'").get().c,
    0,
    "compaction must not install hidden persistence triggers",
  );
  db.close();

  const rebuilt = await openRealRelayStorage(dataDir, false);
  const freshMessage = {
    timestamp: { millis: 2_000, counter: 0, nodeId: "0011223344556677" },
    change: Buffer.alloc(17),
  };
  const rebuiltWrite = await rebuilt.storage.writeMessages(ownerIdBytes, [freshMessage]);
  assert.equal(rebuiltWrite.ok, true, "fresh-owner write must not hit Evolu's non-null assertion");
  assert.deepEqual(rebuilt.storageErrors, []);
  rebuilt.sqlite[Symbol.dispose]();

  const verify = new Database(dbPath, { readonly: true });
  const usage = verify
    .prepare('SELECT "storedBytes", "firstTimestamp", "lastTimestamp" FROM evolu_usage WHERE "ownerId" = ?')
    .get(ownerIdBytes);
  assert.equal(usage.storedBytes, 17);
  assert.notEqual(usage.firstTimestamp, null);
  assert.notEqual(usage.lastTimestamp, null);
  assert.equal(
    verify.prepare('SELECT COUNT(*) AS c FROM evolu_message WHERE "ownerId" = ?').get(ownerIdBytes).c,
    1,
  );
  verify.close();
});

test("compactOwner is idempotent (deletedMessages=0 on already-empty owner)", () => {
  const { db } = setup();
  const ownerIdBytes = randomBytes(16);
  seedOwner(db, ownerIdBytes);

  compactOwner(db, ownerIdBytes);
  const second = compactOwner(db, ownerIdBytes);

  assert.equal(second.deletedMessages, 0);
  assert.equal(second.beforeStoredBytes, 0);
  assert.equal(second.afterStoredBytes, 0);
});

test("compactOwner does not touch other owners' state", () => {
  // Defence-in-depth: a buggy WHERE clause refactor would silently wipe
  // the wrong owner. This test confirms the helper is properly scoped.
  const { db } = setup();
  const ownerA = randomBytes(16);
  const ownerB = randomBytes(16);
  seedOwner(db, ownerA, { messageCount: 5 });
  seedOwner(db, ownerB, { messageCount: 3 });

  compactOwner(db, ownerA);

  const aMsgs = db.prepare('SELECT COUNT(*) as c FROM evolu_message WHERE "ownerId" = ?').get(ownerA);
  const bMsgs = db.prepare('SELECT COUNT(*) as c FROM evolu_message WHERE "ownerId" = ?').get(ownerB);
  const bTs = db.prepare('SELECT COUNT(*) as c FROM evolu_timestamp WHERE "ownerId" = ?').get(ownerB);
  const bUsage = db.prepare('SELECT * FROM evolu_usage WHERE "ownerId" = ?').get(ownerB);
  assert.equal(aMsgs.c, 0, "compact target wiped");
  assert.equal(bMsgs.c, 3, "other owner's messages untouched");
  assert.equal(bTs.c, 3, "other owner's timestamps untouched");
  assert.equal(bUsage.storedBytes, 3000, "other owner's storedBytes untouched");
  assert.notEqual(bUsage.firstTimestamp, null, "other owner's first/lastTimestamp untouched");
});
