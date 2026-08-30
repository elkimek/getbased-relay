import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createConsole, createRun } from "@evolu/common";
import { installPolyfills } from "@evolu/common/polyfills";
import { createRelayDeps } from "@evolu/nodejs";
import { WebSocket } from "ws";

import { createReplayProtectedRelay } from "../dist/lib/replay-protected-relay.js";

installPolyfills();

test("replay-protected relay starts, accepts WebSockets, and shuts down", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "replay-protected-relay-"));
  const previousCwd = process.cwd();
  const console = createConsole({ level: "silent" });
  const logger = {
    console,
    emit: () => {},
    getCurrentConnections: () => 0,
    setOwnerCallback: () => {},
  };
  const run = createRun({ ...createRelayDeps(), console, logger });
  let relay;

  try {
    process.chdir(dataDir);
    const result = await run.abortable(
      createReplayProtectedRelay({
        port: 0,
        isOwnerWithinQuota: () => true,
      }),
    );
    assert.equal(result.ok, true, "relay should start");
    relay = result.value;
    assert.ok(relay.port > 0, "relay should expose its bound ephemeral port");

    const socket = new WebSocket(`ws://127.0.0.1:${relay.port}`);
    await once(socket, "open");
    const closed = once(socket, "close");
    socket.close();
    await closed;
  } finally {
    if (relay) await relay[Symbol.asyncDispose]();
    await run[Symbol.asyncDispose]();
    process.chdir(previousCwd);
    rmSync(dataDir, { recursive: true, force: true });
  }
});
