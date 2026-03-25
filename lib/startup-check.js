// startup-check.js — Validate relay DB integrity on boot

import Database from 'better-sqlite3';
import { existsSync, openSync, readSync, closeSync } from 'fs';
import { join } from 'path';

const EXPECTED_TABLES = ['evolu_timestamp', 'evolu_usage', 'evolu_writeKey', 'evolu_message'];

export function runStartupChecks(config, logger) {
  const dbPath = join(config.dataDir, `${config.relayName}.db`);

  if (!existsSync(dbPath)) {
    logger.emit('info', 'startup.fresh_db', { path: dbPath });
    return { ok: true, fresh: true };
  }

  // Check SQLite magic bytes (read only 16 bytes, not the entire file)
  try {
    const fd = openSync(dbPath, 'r');
    const header = Buffer.alloc(16);
    readSync(fd, header, 0, 16, 0);
    closeSync(fd);
    const magic = header.toString('ascii', 0, 15);
    if (magic !== 'SQLite format 3') {
      logger.emit('error', 'startup.invalid_db', { path: dbPath, magic });
      return { ok: false, error: 'Not a valid SQLite file' };
    }
  } catch (e) {
    logger.emit('error', 'startup.read_failed', { path: dbPath, error: e.message });
    return { ok: false, error: e.message };
  }

  // Run integrity check
  let db;
  try {
    db = new Database(dbPath, { readonly: true });

    const integrity = db.pragma('integrity_check');
    const result = integrity[0]?.integrity_check;
    if (result !== 'ok') {
      logger.emit('error', 'startup.integrity_failed', { path: dbPath, result });
      db.close();
      return { ok: false, error: `Integrity check: ${result}` };
    }

    // Check expected tables exist
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name);
    const missing = EXPECTED_TABLES.filter(t => !tables.includes(t));
    if (missing.length > 0) {
      logger.emit('warn', 'startup.missing_tables', { missing, existing: tables });
    }

    const size = db.prepare('SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()').get();
    logger.emit('info', 'startup.db_validated', {
      path: dbPath,
      sizeBytes: size?.size ?? 0,
      tables: tables.length,
    });

    db.close();
    return { ok: true, fresh: false };
  } catch (e) {
    logger.emit('error', 'startup.validation_failed', { path: dbPath, error: e.message });
    db?.close();
    return { ok: false, error: e.message };
  }
}
