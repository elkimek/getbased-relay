import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import Database from "better-sqlite3";
import { WebSocket } from "ws";
import { createProtocolMessageBuffer, MessageType, ProtocolErrorCode, SubscriptionFlags } from "@evolu/common/local-first";
import { COMPACTION_REPLAY_TABLE, ensureCompactionReplayTable } from "../dist/lib/compaction-replay.js";

async function unusedPorts() {
  const servers = [createServer(), createServer()];
  try {
    for (const server of servers) { server.listen(0, "127.0.0.1"); await once(server, "listening"); }
    return servers.map(server => server.address().port);
  } finally { await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); }
}
async function start(dataDir, relayPort, adminPort) {
  const child = fork(new URL("../dist/index.js", import.meta.url), [], {
    cwd: dataDir, silent: true,
    env: { ...process.env, DATA_DIR: dataDir, RELAY_NAME: "relay", RELAY_PORT: String(relayPort),
      ADMIN_PORT: String(adminPort), SELF_ENABLED: "false", CONTEXT_VERIFIER_ENABLED: "false",
      LOG_LEVEL: "info", LOG_FORMAT: "json", ADMIN_TOKEN: "test-admin" },
  });
  const exited = once(child, "exit");
  let output = "";
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Relay did not start: ${output}`)), 5000);
      child.stdout.on("data", chunk => {
        output += chunk;
        if (output.includes('"event":"relay.ready"')) { clearTimeout(timeout); resolve(); }
      });
      child.stderr.on("data", chunk => { output += chunk; });
      child.once("exit", code => { clearTimeout(timeout); reject(new Error(`Relay exited ${code}: ${output}`)); });
    });
  } catch (error) { child.kill(); await exited; throw error; }
  return { child, exited };
}

test("service reports readiness, preserves data across restart, and shuts down cleanly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-service-"));
  const [relayPort, adminPort] = await unusedPorts();
  let running;
  try {
    running = await start(dir, relayPort, adminPort);
    const health = await fetch(`http://127.0.0.1:${adminPort}/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).status, "ok");
    const socket = new WebSocket(`ws://127.0.0.1:${relayPort}`);
    await once(socket, "open", { signal: AbortSignal.timeout(3000) });
    const frame = createProtocolMessageBuffer(Buffer.alloc(16, 1).toString("base64url"), {
      messageType: MessageType.Request, writeKey: Buffer.alloc(16, 2),
    });
    frame.addMessage({ timestamp: { millis: 1000, counter: 0, nodeId: "0011223344556677" }, change: Buffer.alloc(80) });
    const ack = once(socket, "message", { signal: AbortSignal.timeout(3000) });
    socket.send(frame.unwrap()); await ack;
    const closed = once(socket, "close", { signal: AbortSignal.timeout(3000) });
    running.child.kill("SIGTERM"); await closed;
    assert.deepEqual(await running.exited, [0, null]); running = null;
    running = await start(dir, relayPort, adminPort);
    const metrics = await fetch(`http://127.0.0.1:${adminPort}/metrics`, { headers: { Authorization: "Bearer test-admin" } });
    assert.equal((await metrics.json()).owners.totalStoredBytes, 80);
    const badToken = await fetch(`http://127.0.0.1:${adminPort}/metrics`, { headers: { Authorization: `Bearer ${"é".repeat(10)}` } });
    assert.equal(badToken.status, 401);
    const db = new Database(join(dir, "relay.db"));
    db.exec(`DROP TABLE ${COMPACTION_REPLAY_TABLE}`);
    const missingReplay = await fetch(`http://127.0.0.1:${adminPort}/health`);
    assert.equal(missingReplay.status, 503);
    assert.equal((await missingReplay.json()).status, "unhealthy");
    ensureCompactionReplayTable(db);
    assert.equal((await fetch(`http://127.0.0.1:${adminPort}/health`)).status, 200);
    db.exec("DROP TABLE evolu_timestamp"); db.close();
    assert.equal((await fetch(`http://127.0.0.1:${adminPort}/health`)).status, 503);
    running.child.kill("SIGTERM"); assert.deepEqual(await running.exited, [0, null]); running = null;
  } finally {
    if (running) { running.child.kill("SIGKILL"); await running.exited; }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("storage write errors roll back, do not broadcast, and recover after repair", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-defect-"));
  const [relayPort, adminPort] = await unusedPorts();
  let running;
  let socket;
  let subscriber;
  let db;
  try {
    running = await start(dir, relayPort, adminPort);
    db = new Database(join(dir, "relay.db"));
    const ownerId = Buffer.alloc(16, 1).toString("base64url");
    const response = errorCode => Buffer.from(createProtocolMessageBuffer(ownerId, {
      messageType: MessageType.Response, errorCode,
    }).unwrap());
    const send = async (connection, frame) => {
      const ack = once(connection, "message", { signal: AbortSignal.timeout(3000) });
      connection.send(frame);
      return (await ack)[0];
    };
    subscriber = new WebSocket(`ws://127.0.0.1:${relayPort}`);
    await once(subscriber, "open", { signal: AbortSignal.timeout(3000) });
    const subscription = createProtocolMessageBuffer(ownerId, {
      messageType: MessageType.Request, writeKey: Buffer.alloc(16, 2),
      subscriptionFlag: SubscriptionFlags.Subscribe,
    });
    assert.deepEqual(await send(subscriber, subscription.unwrap()), response(ProtocolErrorCode.NoError));
    const broadcasts = [];
    subscriber.on("message", frame => broadcasts.push(frame));
    // Restore the same table and indexes after the injected failure. There are
    // no timestamps yet, so this repair loses no data in the synthetic DB.
    const timestampSchema = db.prepare(
      "SELECT sql FROM sqlite_master WHERE tbl_name = 'evolu_timestamp' AND sql IS NOT NULL ORDER BY type DESC",
    ).all();
    db.exec("DROP TABLE evolu_timestamp");
    socket = new WebSocket(`ws://127.0.0.1:${relayPort}`);
    await once(socket, "open", { signal: AbortSignal.timeout(3000) });
    const frame = createProtocolMessageBuffer(ownerId, {
      messageType: MessageType.Request, writeKey: Buffer.alloc(16, 2),
    });
    frame.addMessage({ timestamp: { millis: 1000, counter: 0, nodeId: "0011223344556677" }, change: Buffer.alloc(80) });
    const request = frame.unwrap();
    assert.deepEqual(await send(socket, request), response(ProtocolErrorCode.WriteError));
    await sleep(40);
    assert.equal(broadcasts.length, 0, "a failed write must not be broadcast");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM evolu_message").get().n, 0);
    assert.equal(db.prepare("SELECT COALESCE(SUM(storedBytes), 0) AS n FROM evolu_usage").get().n, 0);
    assert.equal(running.child.exitCode, null);
    assert.equal((await fetch(`http://127.0.0.1:${adminPort}/health`)).status, 503);

    for (const { sql } of timestampSchema) db.exec(sql);
    assert.equal((await fetch(`http://127.0.0.1:${adminPort}/health`)).status, 200);
    const delivered = once(subscriber, "message", { signal: AbortSignal.timeout(3000) });
    assert.deepEqual(await send(socket, request), response(ProtocolErrorCode.NoError));
    assert.equal((await delivered)[0].includes(Buffer.alloc(80)), true);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM evolu_message").get().n, 1);
    assert.equal(db.prepare("SELECT storedBytes FROM evolu_usage").get().storedBytes, 80);
    assert.equal(broadcasts.length, 1);
    running.child.kill("SIGTERM");
    assert.deepEqual(await running.exited, [0, null]); running = null;
  } finally {
    socket?.terminate();
    subscriber?.terminate();
    if (running) { running.child.kill("SIGKILL"); await running.exited; }
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
