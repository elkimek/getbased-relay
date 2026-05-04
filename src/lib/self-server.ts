// Self-service HTTP endpoints for owner-scoped operations.
//
// Where /admin/compact-owner is gated by ADMIN_TOKEN (one secret on the VPS,
// only the operator holds it), /self/* endpoints are gated by HMAC-SHA256
// over the owner's writeKey — the same secret the Evolu client already
// holds to push CRDT messages. So the client can act on its own owner
// without round-tripping through the operator, and one user can never act
// on another user's owner.
//
// Endpoints
// ─────────
// POST /self/compact-owner     body  {ownerId, timestamp, signature}
//                              auth  HMAC-SHA256(writeKey, "compact:{ownerId}:{timestamp}")
//                              does  same as /admin/compact-owner: drops
//                                    every evolu_message row for the owner
//                                    and zeroes evolu_usage.storedBytes.
// GET  /self/owner-storage     query ?ownerId=...&timestamp=...&signature=...
//                              auth  HMAC-SHA256(writeKey, "storage:{ownerId}:{timestamp}")
//                              does  returns the relay's actual
//                                    {storedBytes, quotaBytes} for the
//                                    owner. Replaces the client's
//                                    cumulative-bytes estimate (which
//                                    drifts as soon as compaction runs).
//
// Replay defence: the timestamp must be within ±5 minutes of server time;
// outside that window the request is rejected. Inside the window a captured
// signature can be replayed — accepted as the standard cost of a
// stateless HMAC scheme. Compaction is idempotent (second call zeroes
// already-zero bytes) and storage is read-only, so replay is harmless.
//
// This server binds to 0.0.0.0 by default because it's intended to be
// reachable from outside the host (typically via a reverse proxy like
// Caddy with TLS termination). The /admin server stays on 127.0.0.1.

import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { createHmac, timingSafeEqual } from "crypto";
import { join } from "path";
import Database from "better-sqlite3";
import type { RelayConfig } from "./config.js";
import type { Logger } from "./logger.js";

const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 4096;

type WriteKeyLookup = (ownerId: Buffer) => Buffer | null;

// Decode a 22-char base64url ownerId to its 16-byte form. Returns null
// for any malformed input (length, alphabet, decoded length) so callers
// can map to a single 400 path without leaking which check failed.
function decodeOwnerId(s: string | null | undefined): Buffer | null {
  if (typeof s !== "string" || s.length !== 22) return null;
  // Strict base64url alphabet check before decode — Buffer.from is lenient
  // and would accept padding / standard-base64 chars we want to reject.
  if (!/^[A-Za-z0-9_-]{22}$/.test(s)) return null;
  try {
    const buf = Buffer.from(s, "base64url");
    if (buf.length !== 16) return null;
    return buf;
  } catch {
    return null;
  }
}

// Compare two same-length buffers in constant time. Returns false on
// length mismatch (which timingSafeEqual would throw on).
function safeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// Verify HMAC + timestamp window. Looks up writeKey by ownerId. Returns
// null on success; otherwise a {status, error} payload the handler can
// return verbatim. Failures all map to 401 — we deliberately don't
// distinguish "no such owner" from "wrong signature" to avoid an
// owner-existence oracle.
function verifySignature(
  ownerId: Buffer,
  timestampMs: number,
  signatureHex: string,
  context: string,
  ownerIdStr: string,
  lookupWriteKey: WriteKeyLookup,
): { status: number; error: string } | null {
  if (!Number.isFinite(timestampMs)) {
    return { status: 401, error: "invalid_timestamp" };
  }
  const skew = Math.abs(Date.now() - timestampMs);
  if (skew > TIMESTAMP_WINDOW_MS) {
    return { status: 401, error: "timestamp_outside_window" };
  }
  if (typeof signatureHex !== "string" || !/^[0-9a-f]{64}$/i.test(signatureHex)) {
    return { status: 401, error: "invalid_signature_format" };
  }
  const writeKey = lookupWriteKey(ownerId);
  // Constant-time-ish: even on missing writeKey we still do an HMAC over
  // a 32-byte zero buffer + comparison, so the response time doesn't
  // betray owner existence. Not perfect (DB lookup itself can vary), but
  // closes the obvious gap.
  const key = writeKey ?? Buffer.alloc(32);
  const message = `${context}:${ownerIdStr}:${timestampMs}`;
  const expected = createHmac("sha256", key).update(message).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signatureHex, "hex");
  } catch {
    return { status: 401, error: "invalid_signature_format" };
  }
  if (!writeKey || !safeEqual(provided, expected)) {
    return { status: 401, error: "unauthorized" };
  }
  return null;
}

// Read a JSON body up to MAX_BODY_BYTES. Reject anything larger to keep
// a misbehaving client from holding the request open with a stream of
// bytes — request timeout would catch it eventually but we want a
// crisper failure.
function readJsonBody<T = unknown>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(JSON.parse(text) as T);
      } catch (e) {
        reject(e as Error);
      }
    });
    req.on("error", reject);
  });
}

export function createSelfServer(
  config: RelayConfig,
  logger: Logger,
) {
  // Lazily open and reuse a single read-handle for writeKey lookups.
  // Compaction itself opens a fresh write-handle per call (matching the
  // admin path) — keeps the read path responsive even while a compact
  // is in flight under the relay's WAL lock.
  let lookupDb: Database.Database | null = null;
  function lookupWriteKey(ownerId: Buffer): Buffer | null {
    const dbPath = join(config.dataDir, `${config.relayName}.db`);
    if (!lookupDb) {
      lookupDb = new Database(dbPath, { fileMustExist: true, readonly: true });
      lookupDb.pragma("busy_timeout = 5000");
    }
    const row = lookupDb
      .prepare('SELECT "writeKey" FROM evolu_writeKey WHERE "ownerId" = ?')
      .get(ownerId) as { writeKey: Buffer } | undefined;
    return row?.writeKey ?? null;
  }

  function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  async function handleCompactOwner(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let body: { ownerId?: unknown; timestamp?: unknown; signature?: unknown };
    try {
      body = await readJsonBody(req);
    } catch (e) {
      const msg = (e as Error).message === "body_too_large" ? "body_too_large" : "invalid_json";
      jsonResponse(res, 400, { error: msg });
      return;
    }
    const ownerIdStr = typeof body.ownerId === "string" ? body.ownerId : null;
    const ownerId = decodeOwnerId(ownerIdStr);
    if (!ownerId || !ownerIdStr) {
      jsonResponse(res, 400, { error: "invalid_owner_id" });
      return;
    }
    const timestampMs = typeof body.timestamp === "number" ? body.timestamp : NaN;
    const signatureHex = typeof body.signature === "string" ? body.signature : "";
    const authErr = verifySignature(
      ownerId,
      timestampMs,
      signatureHex,
      "compact",
      ownerIdStr,
      lookupWriteKey,
    );
    if (authErr) {
      logger.emit("warn", "self.compact_owner_unauthorized", {
        ownerId: ownerIdStr,
        reason: authErr.error,
      });
      jsonResponse(res, authErr.status, { error: authErr.error });
      return;
    }

    // Run the same DELETE/UPDATE transaction as /admin/compact-owner.
    // Open a fresh write-handle so we don't hold the lookup-DB hostage
    // during the WAL wait.
    const dbPath = join(config.dataDir, `${config.relayName}.db`);
    let db: Database.Database | null = null;
    try {
      db = new Database(dbPath, { fileMustExist: true });
      db.pragma("busy_timeout = 30000");
      let before: { storedBytes: number } | undefined;
      let after: { storedBytes: number } | undefined;
      let deletedMessages = 0;
      const tx = db.transaction(() => {
        before = db!
          .prepare('SELECT "storedBytes" FROM evolu_usage WHERE "ownerId" = ?')
          .get(ownerId) as { storedBytes: number } | undefined;
        const cnt = db!
          .prepare('SELECT COUNT(*) as c FROM evolu_message WHERE "ownerId" = ?')
          .get(ownerId) as { c: number };
        deletedMessages = cnt.c;
        db!
          .prepare('DELETE FROM evolu_message WHERE "ownerId" = ?')
          .run(ownerId);
        db!
          .prepare('UPDATE evolu_usage SET "storedBytes" = 0 WHERE "ownerId" = ?')
          .run(ownerId);
        after = db!
          .prepare('SELECT "storedBytes" FROM evolu_usage WHERE "ownerId" = ?')
          .get(ownerId) as { storedBytes: number } | undefined;
      });
      tx();
      logger.emit("info", "self.compact_owner", {
        ownerId: ownerIdStr,
        deletedMessages,
        beforeStoredBytes: before?.storedBytes ?? 0,
        afterStoredBytes: after?.storedBytes ?? 0,
      });
      jsonResponse(res, 200, {
        ownerId: ownerIdStr,
        deletedMessages,
        beforeStoredBytes: before?.storedBytes ?? 0,
        afterStoredBytes: after?.storedBytes ?? 0,
      });
    } catch (e) {
      logger.emit("warn", "self.compact_owner_failed", {
        ownerId: ownerIdStr,
        error: (e as Error).message,
      });
      jsonResponse(res, 500, { error: "compact_failed" });
    } finally {
      try { db?.close(); } catch {}
    }
  }

  function handleOwnerStorage(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): void {
    const ownerIdStr = url.searchParams.get("ownerId");
    const ownerId = decodeOwnerId(ownerIdStr);
    if (!ownerId || !ownerIdStr) {
      jsonResponse(res, 400, { error: "invalid_owner_id" });
      return;
    }
    const timestampMs = Number(url.searchParams.get("timestamp"));
    const signatureHex = url.searchParams.get("signature") ?? "";
    const authErr = verifySignature(
      ownerId,
      timestampMs,
      signatureHex,
      "storage",
      ownerIdStr,
      lookupWriteKey,
    );
    if (authErr) {
      logger.emit("warn", "self.owner_storage_unauthorized", {
        ownerId: ownerIdStr,
        reason: authErr.error,
      });
      jsonResponse(res, authErr.status, { error: authErr.error });
      return;
    }
    try {
      const dbPath = join(config.dataDir, `${config.relayName}.db`);
      const readDb = new Database(dbPath, { fileMustExist: true, readonly: true });
      try {
        readDb.pragma("busy_timeout = 5000");
        const row = readDb
          .prepare('SELECT "storedBytes" FROM evolu_usage WHERE "ownerId" = ?')
          .get(ownerId) as { storedBytes: number } | undefined;
        jsonResponse(res, 200, {
          ownerId: ownerIdStr,
          storedBytes: row?.storedBytes ?? 0,
          quotaBytes: config.quotaPerOwnerBytes,
        });
      } finally {
        readDb.close();
      }
    } catch (e) {
      logger.emit("warn", "self.owner_storage_failed", {
        ownerId: ownerIdStr,
        error: (e as Error).message,
      });
      jsonResponse(res, 500, { error: "storage_failed" });
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${config.selfPort}`);

    // CORS preflight: allow any origin since this is HMAC-authed (the
    // signature is the only thing that matters; cookies / referrer don't
    // factor in). Restrict to the two methods + content-type the server
    // actually accepts.
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600",
      });
      res.end();
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", "*");

    if (req.method === "POST" && url.pathname === "/self/compact-owner") {
      void handleCompactOwner(req, res);
      return;
    }
    if (req.method === "GET" && url.pathname === "/self/owner-storage") {
      handleOwnerStorage(req, res, url);
      return;
    }
    jsonResponse(res, 404, { error: "Not found" });
  });

  // Same hardening as the admin server — small headers timeout, short
  // request timeout. Body cap is enforced inside readJsonBody so a slow
  // streaming POST doesn't hold the connection open indefinitely.
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;

  function start(): Promise<void> {
    return new Promise((resolve, reject) => {
      server.listen(config.selfPort, config.selfBind, () => {
        logger.emit("info", "self.started", {
          port: config.selfPort,
          bind: config.selfBind,
        });
        resolve();
      });
      server.on("error", reject);
    });
  }

  function stop(): Promise<void> {
    return new Promise((resolve) => {
      try { lookupDb?.close(); } catch {}
      lookupDb = null;
      server.close(() => resolve());
    });
  }

  // Exported for tests — verifySignature has no side effects so it's
  // safe to expose as a pure helper.
  return { start, stop, _verifySignature: verifySignature, _decodeOwnerId: decodeOwnerId };
}
