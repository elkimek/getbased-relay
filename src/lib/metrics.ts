import Database from "better-sqlite3";
import { statSync } from "fs";
import { join } from "path";
import { COMPACTION_REPLAY_TABLE } from "./compaction-replay.js";
import type { RelayConfig } from "./config.js";
import type { Logger } from "./logger.js";

interface OwnerUsage {
  ownerId: string;
  storedBytes: number;
}

export interface Metrics {
  getOwnerCount: () => number;
  getPerOwnerUsage: () => OwnerUsage[];
  getTotalStoredBytes: () => number;
  /** Strict, single-snapshot read for admission checks; never falls back to zero. */
  getQuotaUsage: (ownerId: string) => { totalStoredBytes: number; ownerStoredBytes: number };
  isReady: () => boolean;
  getDbFileSize: () => number;
  close: () => void;
}

export function createMetrics(config: RelayConfig, logger: Logger): Metrics {
  const dbPath = join(config.dataDir, `${config.relayName}.db`);
  let db: Database.Database | null = null;

  function open(): void {
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      logger.emit("info", "metrics.db_opened", { path: dbPath });
    } catch (e) {
      logger.emit("warn", "metrics.db_unavailable", {
        path: dbPath,
        error: (e as Error).message,
      });
      db = null;
    }
  }

  function ensureDb(): boolean {
    if (db) return true;
    open();
    return db !== null;
  }

  function query<T>(fn: (db: Database.Database) => T, fallback: T): T {
    if (!ensureDb()) return fallback;
    try {
      return fn(db!);
    } catch (e) {
      logger.emit("warn", "metrics.query_failed", {
        error: (e as Error).message,
      });
      try {
        db?.close();
      } catch {}
      db = null;
      if (!ensureDb()) return fallback;
      try {
        return fn(db!);
      } catch {
        return fallback;
      }
    }
  }

  function ownerIdToString(ownerId: unknown): string {
    if (!ownerId) return "<unknown>";
    if (typeof ownerId === "string") return ownerId;
    return Buffer.from(ownerId as Uint8Array).toString("base64url");
  }

  function getOwnerCount(): number {
    return query(
      (db) =>
        (
          db
            .prepare(
              'SELECT COUNT(DISTINCT "ownerId") as cnt FROM evolu_usage',
            )
            .get() as { cnt: number } | undefined
        )?.cnt ?? 0,
      0,
    );
  }

  function getPerOwnerUsage(): OwnerUsage[] {
    return query(
      (db) =>
        (
          db
            .prepare('SELECT "ownerId", "storedBytes" FROM evolu_usage')
            .all() as Array<{ ownerId: unknown; storedBytes: number }>
        ).map((r) => ({
          ownerId: ownerIdToString(r.ownerId),
          storedBytes: r.storedBytes,
        })),
      [],
    );
  }

  function getTotalStoredBytes(): number {
    return query(
      (db) =>
        (
          db
            .prepare(
              'SELECT COALESCE(SUM("storedBytes"), 0) as total FROM evolu_usage',
            )
            .get() as { total: number } | undefined
        )?.total ?? 0,
      0,
    );
  }

  function getDbFileSize(): number {
    try {
      return statSync(dbPath).size;
    } catch {
      return 0;
    }
  }

  function getQuotaUsage(ownerId: string) {
    if (!ensureDb()) throw new Error("Relay usage database unavailable");
    return db!.prepare(`
      SELECT COALESCE(SUM("storedBytes"), 0) AS totalStoredBytes,
        COALESCE((SELECT "storedBytes" FROM evolu_usage WHERE "ownerId" = ?), 0)
          AS ownerStoredBytes
      FROM evolu_usage
    `).get(Buffer.from(ownerId, "base64url")) as {
      totalStoredBytes: number; ownerStoredBytes: number;
    };
  }

  function isReady(): boolean {
    if (!ensureDb()) return false;
    try {
      const row = db!.prepare(`
        SELECT COUNT(*) AS count FROM sqlite_master
        WHERE type = 'table' AND name IN
          ('evolu_timestamp', 'evolu_usage', 'evolu_writeKey', 'evolu_message', ?)
      `).get(COMPACTION_REPLAY_TABLE) as { count: number };
      return row.count === 5;
    } catch {
      return false;
    }
  }

  function close(): void {
    if (db) {
      try {
        db.close();
      } catch {}
      db = null;
    }
  }

  return {
    getOwnerCount,
    getPerOwnerUsage,
    getTotalStoredBytes,
    getQuotaUsage,
    isReady,
    getDbFileSize,
    close,
  };
}
