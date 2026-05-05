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

// Per-IP token-bucket rate limit. Compact is bandwidth-cheap but does
// real DB work (DELETE + UPDATE under WAL lock); storage is just a
// SELECT. Compact gets the tighter cap. Both are generous enough that
// a real user with one device + occasional refreshes never trips them,
// but a captured-signature replay flood is bounded.
const RATE_LIMITS: Record<string, { capacity: number; windowMs: number }> = {
  "compact": { capacity: 10, windowMs: 60 * 1000 },
  "storage": { capacity: 60, windowMs: 60 * 1000 },
};
// Coalesce repeated unauthorized log lines per (ownerId, ip, reason).
// First failure logs immediately; same key within window suppresses
// (with a count summary on window expiry). Without this, a spammer
// can fill the log with thousands of identical "wrong sig" warnings.
const LOG_COALESCE_WINDOW_MS = 60 * 1000;

// Hard cap on rate-limit + coalesce Maps. The 30s sweep below cleans
// expired entries, but a high-cardinality flood (botnet, scanner
// rotating millions of IPs) could grow either Map between sweeps.
// Cap + LRU eviction keeps memory bounded regardless of input shape.
// 10k entries is generous: at typical relay load it'll never approach
// the cap even during sweep cycles. Map preserves insertion order, so
// the first key is the least-recently-touched.
const MAX_BUCKET_ENTRIES = 10_000;
const MAX_COALESCE_ENTRIES = 10_000;
function evictOldest<K, V>(m: Map<K, V>, cap: number): void {
  while (m.size > cap) {
    const oldest = m.keys().next().value;
    if (oldest === undefined) break;
    m.delete(oldest);
  }
}

type WriteKeyLookup = (ownerId: Buffer) => Buffer | null;

interface BucketState { count: number; resetAt: number }
interface CoalesceState { count: number; firstAt: number; expiresAt: number }

// Pull the real client IP. When req.socket is loopback (relay sits
// behind Caddy on the same host), trust X-Forwarded-For — Caddy sets
// it by default on reverse_proxy. Otherwise use the socket peer.
// Multi-hop XFF: we want the LEFTMOST entry (the original client),
// since intermediate proxies append to the right.
function clientIp(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress || "0.0.0.0";
  const isLoopback = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  if (isLoopback) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.length > 0) {
      const first = xff.split(",")[0]?.trim();
      if (first) return first;
    }
  }
  return peer;
}

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
  // ─── Rate limit + log coalesce state ────────────────────────
  // Both keyed by string. Cleaned up by a periodic sweep so neither
  // map grows unbounded under a long-running scan flood.
  const buckets = new Map<string, BucketState>();
  const coalesce = new Map<string, CoalesceState>();

  // Returns true if the request fits the bucket; false if rate-limited.
  // Caller maps false → 429 with Retry-After.
  //
  // LRU touch: every access (allowed or denied) re-insertion-orders
  // the key so that under MAX_BUCKET_ENTRIES eviction, only truly
  // idle keys get dropped.
  function rateCheck(ip: string, route: keyof typeof RATE_LIMITS): { allowed: boolean; retryAfterSec: number } {
    const cfg = RATE_LIMITS[route];
    const now = Date.now();
    const key = `${ip}:${route}`;
    const cur = buckets.get(key);
    if (!cur || cur.resetAt <= now) {
      buckets.delete(key); // ensure fresh insertion-order position
      buckets.set(key, { count: 1, resetAt: now + cfg.windowMs });
      evictOldest(buckets, MAX_BUCKET_ENTRIES);
      return { allowed: true, retryAfterSec: 0 };
    }
    // LRU touch: re-insert so this key isn't a candidate for eviction.
    buckets.delete(key);
    if (cur.count < cfg.capacity) {
      cur.count += 1;
      buckets.set(key, cur);
      return { allowed: true, retryAfterSec: 0 };
    }
    buckets.set(key, cur);
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((cur.resetAt - now) / 1000)) };
  }

  // Returns true if this is a "fresh" event that should be logged
  // immediately. Subsequent failures matching the same (ownerId, ip,
  // reason) within the window increment a counter without logging.
  // The sweep below emits a "coalesced N within Xs" summary on
  // window expiry if N > 1.
  //
  // LRU touch + cap match the rate-limit pattern — protects against
  // a flood that rotates ownerId/ip/reason fast enough that nothing
  // expires the natural way.
  function logShouldEmit(ownerIdStr: string, ip: string, reason: string): boolean {
    const key = `${ownerIdStr}|${ip}|${reason}`;
    const now = Date.now();
    const cur = coalesce.get(key);
    if (!cur || cur.expiresAt <= now) {
      coalesce.delete(key);
      coalesce.set(key, { count: 1, firstAt: now, expiresAt: now + LOG_COALESCE_WINDOW_MS });
      evictOldest(coalesce, MAX_COALESCE_ENTRIES);
      return true;
    }
    coalesce.delete(key);
    cur.count += 1;
    coalesce.set(key, cur);
    return false;
  }

  // Periodic sweep — drops expired buckets + emits coalesce-summary
  // log lines for any keys whose window just closed with count > 1.
  // 30s cadence is twice the smallest window so we never miss a bucket
  // by more than one window in the worst case.
  const sweepInterval = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
    for (const [k, c] of coalesce) {
      if (c.expiresAt <= now) {
        if (c.count > 1) {
          const [ownerId, ip, reason] = k.split("|");
          logger.emit("warn", "self.coalesced_unauthorized", {
            ownerId, ip, reason,
            count: c.count,
            windowMs: now - c.firstAt,
          });
        }
        coalesce.delete(k);
      }
    }
  }, 30 * 1000);
  // Don't keep the event loop alive on this — relay shutdown should
  // not have to wait for a 30s timer to fire.
  if (typeof sweepInterval.unref === "function") sweepInterval.unref();

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
    const ip = clientIp(req);
    const rl = rateCheck(ip, "compact");
    if (!rl.allowed) {
      res.setHeader("Retry-After", String(rl.retryAfterSec));
      jsonResponse(res, 429, { error: "rate_limited", retryAfterSec: rl.retryAfterSec });
      return;
    }
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
      if (logShouldEmit(ownerIdStr, ip, `compact:${authErr.error}`)) {
        logger.emit("warn", "self.compact_owner_unauthorized", {
          ownerId: ownerIdStr,
          ip,
          reason: authErr.error,
        });
      }
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
    const ip = clientIp(req);
    const rl = rateCheck(ip, "storage");
    if (!rl.allowed) {
      res.setHeader("Retry-After", String(rl.retryAfterSec));
      jsonResponse(res, 429, { error: "rate_limited", retryAfterSec: rl.retryAfterSec });
      return;
    }
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
      if (logShouldEmit(ownerIdStr, ip, `storage:${authErr.error}`)) {
        logger.emit("warn", "self.owner_storage_unauthorized", {
          ownerId: ownerIdStr,
          ip,
          reason: authErr.error,
        });
      }
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
      try { clearInterval(sweepInterval); } catch {}
      try { lookupDb?.close(); } catch {}
      lookupDb = null;
      server.close(() => resolve());
    });
  }

  // Exported for tests — verifySignature has no side effects so it's
  // safe to expose as a pure helper.
  return {
    start,
    stop,
    _verifySignature: verifySignature,
    _decodeOwnerId: decodeOwnerId,
    _rateCheck: rateCheck,
    _logShouldEmit: logShouldEmit,
    _clientIp: clientIp,
  };
}
