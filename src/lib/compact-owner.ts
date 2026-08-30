// Shared compact-owner transaction used by both /admin/compact-owner and
// /self/compact-owner. Lives here so the two endpoints can't drift on what
// "compact" actually wipes — every cleanup step (evolu_message rows,
// evolu_timestamp merkle/fingerprint rows, evolu_usage bookkeeping) runs
// inside one transaction so a partial failure can't strand the owner in
// a half-cleaned state where the next client push gets rejected as
// "already-seen" (see fix history at PR #10 for the production repro).

import type Database from "better-sqlite3";
import {
  countCompactedTimestamps,
  preserveCompactedTimestamps,
} from "./compaction-replay.js";

export interface CompactOwnerResult {
  deletedMessages: number;
  protectedTimestamps: number;
  beforeStoredBytes: number;
  afterStoredBytes: number;
}

/**
 * Atomically replaces the owner's encrypted history with compact replay
 * tombstones, then drops its live Evolu state:
 *  - getbased_compacted_timestamp rows retain only each deleted message's
 *    16-byte timestamp so an offline replica cannot upload that payload again
 *  - evolu_message rows (the encrypted CRDT log)
 *  - evolu_timestamp rows (the merkle/fingerprint table feeding negentropy
 *    reconciliation — leaving these populated after evolu_message is gone
 *    makes the relay report fingerprints for timestamps without payloads,
 *    so peers' subsequent per-row pushes get rejected as "you already have
 *    it" and silently disappear)
 *  - evolu_usage row (deleted so Evolu's next write takes the fresh-owner
 *    path and recreates valid non-null first/last timestamps)
 *
 * Caller passes an open `Database` handle with `busy_timeout` already set
 * to whatever they want (admin and self both use 30s). The transaction is
 * synchronous via better-sqlite3.
 */
export function compactOwner(
  db: Database.Database,
  ownerId: Buffer,
): CompactOwnerResult {
  let before: { storedBytes: number } | undefined;
  let after: { storedBytes: number } | undefined;
  let deletedMessages = 0;
  const tx = db.transaction(() => {
    before = db
      .prepare('SELECT "storedBytes" FROM evolu_usage WHERE "ownerId" = ?')
      .get(ownerId) as { storedBytes: number } | undefined;
    const cnt = db
      .prepare('SELECT COUNT(*) as c FROM evolu_message WHERE "ownerId" = ?')
      .get(ownerId) as { c: number };
    deletedMessages = cnt.c;
    preserveCompactedTimestamps(db, ownerId);
    db.prepare('DELETE FROM evolu_message WHERE "ownerId" = ?').run(ownerId);
    db.prepare('DELETE FROM evolu_timestamp WHERE "ownerId" = ?').run(ownerId);
    // An existing usage row with NULL timestamps makes Evolu reject rebuild
    // writes with ProtocolInvalidDataError. No row is the empty-owner state.
    db.prepare('DELETE FROM evolu_usage WHERE "ownerId" = ?').run(ownerId);
    after = db
      .prepare('SELECT "storedBytes" FROM evolu_usage WHERE "ownerId" = ?')
      .get(ownerId) as { storedBytes: number } | undefined;
  });
  tx();
  return {
    deletedMessages,
    protectedTimestamps: countCompactedTimestamps(db, ownerId),
    beforeStoredBytes: before?.storedBytes ?? 0,
    afterStoredBytes: after?.storedBytes ?? 0,
  };
}
