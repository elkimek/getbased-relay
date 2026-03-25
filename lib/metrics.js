// metrics.js — Read-only SQLite queries against the Evolu relay DB

import Database from 'better-sqlite3';
import { statSync } from 'fs';
import { join } from 'path';

export function createMetrics(config, logger) {
  const dbPath = join(config.dataDir, `${config.relayName}.db`);
  let db = null;

  function open() {
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
      logger.emit('info', 'metrics.db_opened', { path: dbPath });
    } catch (e) {
      logger.emit('warn', 'metrics.db_unavailable', { path: dbPath, error: e.message });
      db = null;
    }
  }

  function ensureDb() {
    if (db) return true;
    open();
    return db !== null;
  }

  // Reconnect on stale/corrupt handle
  function query(fn, fallback) {
    if (!ensureDb()) return fallback;
    try {
      return fn(db);
    } catch (e) {
      logger.emit('warn', 'metrics.query_failed', { error: e.message });
      // Close stale handle and retry once
      try { db.close(); } catch {}
      db = null;
      if (!ensureDb()) return fallback;
      try {
        return fn(db);
      } catch {
        return fallback;
      }
    }
  }

  function ownerIdToHex(ownerId) {
    if (typeof ownerId === 'string') return ownerId;
    return Buffer.from(ownerId).toString('hex');
  }

  function getOwnerCount() {
    return query(
      db => db.prepare('SELECT COUNT(DISTINCT "ownerId") as cnt FROM evolu_usage').get()?.cnt ?? 0,
      0
    );
  }

  function getPerOwnerUsage() {
    return query(
      db => db.prepare('SELECT "ownerId", "storedBytes" FROM evolu_usage').all().map(r => ({
        ownerId: ownerIdToHex(r.ownerId),
        storedBytes: r.storedBytes,
      })),
      []
    );
  }

  function getTotalStoredBytes() {
    return query(
      db => db.prepare('SELECT COALESCE(SUM("storedBytes"), 0) as total FROM evolu_usage').get()?.total ?? 0,
      0
    );
  }

  function getDbFileSize() {
    try {
      return statSync(dbPath).size;
    } catch { return 0; }
  }

  function close() {
    if (db) {
      try { db.close(); } catch {}
      db = null;
    }
  }

  return { getOwnerCount, getPerOwnerUsage, getTotalStoredBytes, getDbFileSize, close };
}
