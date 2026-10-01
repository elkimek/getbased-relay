import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { test } from "node:test";
import Database from "better-sqlite3";
import { WebSocket } from "ws";
import { createProtocolMessageBuffer, MessageType } from "@evolu/common/local-first";

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
    db.exec("DROP TABLE evolu_timestamp"); db.close();
    assert.equal((await fetch(`http://127.0.0.1:${adminPort}/health`)).status, 503);
    running.child.kill("SIGTERM"); assert.deepEqual(await running.exited, [0, null]); running = null;
  } finally {
    if (running) { running.child.kill("SIGKILL"); await running.exited; }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a fatal storage defect stops the whole service with failure status", async () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-defect-"));
  const [relayPort, adminPort] = await unusedPorts();
  let running;
  let socket;
  try {
    running = await start(dir, relayPort, adminPort);
    const db = new Database(join(dir, "relay.db"));
    db.exec("DROP TABLE evolu_timestamp"); db.close();
    socket = new WebSocket(`ws://127.0.0.1:${relayPort}`);
    await once(socket, "open", { signal: AbortSignal.timeout(3000) });
    const frame = createProtocolMessageBuffer(Buffer.alloc(16, 1).toString("base64url"), {
      messageType: MessageType.Request, writeKey: Buffer.alloc(16, 2),
    });
    frame.addMessage({ timestamp: { millis: 1000, counter: 0, nodeId: "0011223344556677" }, change: Buffer.alloc(80) });
    socket.send(frame.unwrap());
    const timeout = setTimeout(() => running?.child.kill("SIGKILL"), 5000);
    try { assert.deepEqual(await running.exited, [1, null]); running = null; }
    finally { clearTimeout(timeout); }
  } finally {
    socket?.terminate();
    if (running) { running.child.kill("SIGKILL"); await running.exited; }
    rmSync(dir, { recursive: true, force: true });
  }
});
