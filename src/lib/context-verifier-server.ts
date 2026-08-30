// Private signature-verification service for the Agent Access context gateway.
//
// The gateway is intentionally not trusted with the relay database. It sends
// the already-hashed, domain-separated message fields here and receives only a
// boolean result. The write key never leaves this process.

import { createHmac, timingSafeEqual } from "crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { chmodSync, mkdirSync, rmSync } from "fs";
import { dirname, join } from "path";
import Database from "better-sqlite3";
import type { RelayConfig } from "./config.js";
import type { Logger } from "./logger.js";

const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 8 * 1024;

type VerificationBody = {
  ownerId?: unknown;
  timestamp?: unknown;
  signature?: unknown;
  tokenHash?: unknown;
  profileId?: unknown;
  contextHash?: unknown;
};

function safeEqualHex(aHex: string, b: Buffer): boolean {
  if (!/^[0-9a-f]{64}$/i.test(aHex)) return false;
  const a = Buffer.from(aHex, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function checkBearer(req: IncomingMessage, token: string): boolean {
  const provided = req.headers.authorization ?? "";
  const expected = `Bearer ${token}`;
  return (
    provided.length === expected.length &&
    timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
  );
}

function json(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

function readJsonBody(req: IncomingMessage): Promise<VerificationBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error("payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function decodeOwnerId(ownerId: unknown): Buffer | null {
  if (typeof ownerId !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(ownerId)) {
    return null;
  }
  try {
    const decoded = Buffer.from(ownerId, "base64url");
    return decoded.length === 16 ? decoded : null;
  } catch {
    return null;
  }
}

export function createContextVerifierServer(
  config: RelayConfig,
  logger: Logger,
) {
  const dbPath = join(config.dataDir, `${config.relayName}.db`);
  const verifierToken = config.contextVerifierToken;
  if (!verifierToken) {
    throw new Error("Context verifier requires CONTEXT_VERIFIER_TOKEN");
  }

  function lookupWriteKey(ownerId: Buffer): Buffer | null {
    const db = new Database(dbPath, { fileMustExist: true, readonly: true });
    try {
      db.pragma("busy_timeout = 5000");
      const row = db
        .prepare('SELECT "writeKey" FROM evolu_writeKey WHERE "ownerId" = ?')
        .get(ownerId) as { writeKey: Buffer } | undefined;
      return row?.writeKey ?? null;
    } finally {
      db.close();
    }
  }

  async function handleVerify(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    let body: VerificationBody;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      json(res, (error as Error).message === "payload_too_large" ? 413 : 400, {
        ok: false,
      });
      return;
    }

    const ownerId = decodeOwnerId(body.ownerId);
    const timestamp = Number(body.timestamp);
    const signature = typeof body.signature === "string" ? body.signature : "";
    const tokenHash = typeof body.tokenHash === "string" ? body.tokenHash : "";
    const profileId = typeof body.profileId === "string" ? body.profileId : "";
    const contextHash = typeof body.contextHash === "string" ? body.contextHash : "";
    if (
      !ownerId ||
      !Number.isFinite(timestamp) ||
      Math.abs(Date.now() - timestamp) > TIMESTAMP_WINDOW_MS ||
      !/^[0-9a-f]{64}$/i.test(signature) ||
      !/^[0-9a-f]{64}$/i.test(tokenHash) ||
      !/^[a-zA-Z0-9_-]+$/.test(profileId) ||
      !/^[0-9a-f]{64}$/i.test(contextHash)
    ) {
      // Deliberately uniform: do not reveal which owner or proof component
      // failed validation.
      json(res, 401, { ok: false });
      return;
    }

    let writeKey: Buffer | null = null;
    try {
      writeKey = lookupWriteKey(ownerId);
      const message = `agent-context:${body.ownerId}:${timestamp}:${tokenHash}:${profileId}:${contextHash}`;
      const expected = createHmac("sha256", writeKey ?? Buffer.alloc(32))
        .update(message)
        .digest();
      const ok = Boolean(writeKey && safeEqualHex(signature, expected));
      json(res, ok ? 200 : 401, { ok });
    } catch (error) {
      logger.emit("warn", "context_verifier.failed", {
        error: (error as Error).message,
      });
      json(res, 503, { ok: false });
    }
  }

  const server = createServer((req, res) => {
    if (!checkBearer(req, verifierToken)) {
      json(res, 401, { ok: false });
      return;
    }
    // This is a single-purpose authenticated Unix-socket service, not a
    // general HTTP router. Dispatch every authenticated request to the same
    // read-only verifier; malformed or body-less requests fail JSON/proof
    // validation without reaching a second operation.
    void handleVerify(req, res);
  });

  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 100;

  function start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ready = () => {
        if (config.contextVerifierSocket) {
          chmodSync(config.contextVerifierSocket, 0o660);
        }
        logger.emit("info", "context_verifier.started", {
          socket: config.contextVerifierSocket,
          port: config.contextVerifierSocket ? null : config.contextVerifierPort,
          bind: config.contextVerifierSocket ? null : config.contextVerifierBind,
        });
        resolve();
      };
      if (config.contextVerifierSocket) {
        mkdirSync(dirname(config.contextVerifierSocket), { recursive: true });
        rmSync(config.contextVerifierSocket, { force: true });
        server.listen(config.contextVerifierSocket, ready);
      } else {
        server.listen(
          config.contextVerifierPort,
          config.contextVerifierBind,
          ready,
        );
      }
      server.on("error", reject);
    });
  }

  function stop(): Promise<void> {
    return new Promise((resolve) =>
      server.close(() => {
        if (config.contextVerifierSocket) {
          rmSync(config.contextVerifierSocket, { force: true });
        }
        resolve();
      }),
    );
  }

  return { server, start, stop };
}
