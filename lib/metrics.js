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

  function getOwnerCount() {
    if (!ensureDb()) return 0;
    try {
      const row = db.prepare('SELECT COUNT(DISTINCT "ownerId") as cnt FROM evolu_usage').get();
      return row?.cnt ?? 0;
    } catch { return 0; }
  }

  function getPerOwnerUsage() {
    if (!ensureDb()) return [];
    try {
      const rows = db.prepare('SELECT "ownerId", "storedBytes" FROM evolu_usage').all();
      return rows.map(r => ({
        ownerId: Buffer.from(r.ownerId).toString('hex'),
        storedBytes: r.storedBytes,
      }));
    } catch { return []; }
  }

  function getTotalStoredBytes() {
    if (!ensureDb()) return 0;
    try {
      const row = db.prepare('SELECT COALESCE(SUM("storedBytes"), 0) as total FROM evolu_usage').get();
      return row?.total ?? 0;
    } catch { return 0; }
  }

  function getDbFileSize() {
    try {
      return statSync(dbPath).size;
    } catch { return 0; }
  }

  function close() {
    if (db) {
      db.close();
      db = null;
    }
  }

  return { getOwnerCount, getPerOwnerUsage, getTotalStoredBytes, getDbFileSize, close };
}
