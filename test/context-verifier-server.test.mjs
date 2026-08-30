import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { createContextVerifierServer } from "../dist/lib/context-verifier-server.js";

let verifier;
let port;
let dbPath;
let ownerId;
let ownerBytes;
let writeKey;

function config(dataDir) {
  return {
    relayPort: 4000,
    adminPort: 4002,
    selfPort: 4003,
    selfBind: "127.0.0.1",
    selfEnabled: true,
    contextVerifierPort: port,
    contextVerifierBind: "127.0.0.1",
    contextVerifierSocket: null,
    contextVerifierEnabled: true,
    contextVerifierToken: "verifier-test-token",
    relayName: "evolu-relay",
    dataDir,
    quotaPerOwnerBytes: 10 * 1024 * 1024,
    quotaGlobalBytes: 1000 * 1024 * 1024,
    ownerTtlDays: 90,
    logLevel: "info",
    logFormat: "json",
    enableEvoluLogging: false,
    adminToken: null,
  };
}

function replaceDatabase(key) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE evolu_writeKey (
      "ownerId" blob not null,
      "writeKey" blob not null,
      primary key ("ownerId")
    ) strict;
  `);
  db.prepare('INSERT INTO evolu_writeKey ("ownerId", "writeKey") VALUES (?, ?)').run(
    ownerBytes,
    key,
  );
  db.close();
}

function signedBody(overrides = {}) {
  const base = {
    ownerId,
    timestamp: Date.now(),
    tokenHash: "a".repeat(64),
    profileId: "default",
    contextHash: "b".repeat(64),
  };
  const body = { ...base, ...overrides };
  const message = `agent-context:${body.ownerId}:${body.timestamp}:${body.tokenHash}:${body.profileId}:${body.contextHash}`;
  return {
    ...body,
    signature: createHmac("sha256", writeKey).update(message).digest("hex"),
  };
}

async function verify(body, token = "verifier-test-token") {
  return fetch(`http://127.0.0.1:${port}/verify-agent-context`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

before(async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "context-verifier-"));
  dbPath = join(dataDir, "evolu-relay.db");
  ownerBytes = randomBytes(16);
  ownerId = ownerBytes.toString("base64url");
  writeKey = randomBytes(32);
  replaceDatabase(writeKey);
  port = 17000 + Math.floor(Math.random() * 1000);
  verifier = createContextVerifierServer(config(dataDir), { emit() {} });
  await verifier.start();
});

after(async () => {
  await verifier?.stop();
});

test("validates the unchanged Agent Access HMAC contract", async () => {
  const response = await verify(signedBody());
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test("rejects wrong caller bearer and wrong owner proof uniformly", async () => {
  const wrongBearer = await verify(signedBody(), "wrong-token");
  assert.equal(wrongBearer.status, 401);
  assert.deepEqual(await wrongBearer.json(), { ok: false });

  const wrongProof = signedBody();
  wrongProof.signature = "0".repeat(64);
  const response = await verify(wrongProof);
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { ok: false });
});

test("opens the current database for every proof after key rotation", async () => {
  const rotated = randomBytes(32);
  const db = new Database(dbPath);
  db.prepare('UPDATE evolu_writeKey SET "writeKey" = ? WHERE "ownerId" = ?').run(
    rotated,
    ownerBytes,
  );
  db.close();
  writeKey = rotated;
  assert.equal((await verify(signedBody())).status, 200);
});
