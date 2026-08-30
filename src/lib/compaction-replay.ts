// Relay-side replay protection for owner compaction.
//
// Evolu replicas retain an append-only local message history. Deleting the
// relay copy alone is therefore temporary: an offline paired device can later
// upload every deleted message again. Compaction stores only each deleted
// message's 16-byte HLC timestamp in this table. The wrapped relay storage
// acknowledges exact replays without re-inserting their encrypted payloads.

import Database from "better-sqlite3";
import { isNonEmptyArray, ok } from "@evolu/common";
import {
  ownerIdBytesToOwnerId,
  timestampToTimestampBytes,
  type EncryptedCrdtMessage,
  type OwnerIdBytes,
  type Storage,
} from "@evolu/common/local-first";
import type { Logger } from "./logger.js";
import { withOwnerWriteLock } from "./owner-write-lock.js";

export const COMPACTION_REPLAY_TABLE = "getbased_compacted_timestamp";

export function ensureCompactionReplayTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${COMPACTION_REPLAY_TABLE} (
      "ownerId" blob not null,
      "timestamp" blob not null,
      primary key ("ownerId", "timestamp")
    ) strict, without rowid
  `);
}

export function preserveCompactedTimestamps(
  db: Database.Database,
  ownerId: Buffer,
): number {
  ensureCompactionReplayTable(db);
  return db.prepare(`
    INSERT OR IGNORE INTO ${COMPACTION_REPLAY_TABLE}
      ("ownerId", "timestamp")
    SELECT "ownerId", "timestamp"
    FROM evolu_message
    WHERE "ownerId" = ?
  `).run(ownerId).changes;
}

export function countCompactedTimestamps(
  db: Database.Database,
  ownerId: Buffer,
): number {
  ensureCompactionReplayTable(db);
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM ${COMPACTION_REPLAY_TABLE}
    WHERE "ownerId" = ?
  `).get(ownerId) as { count: number } | undefined;
  return row?.count ?? 0;
}

export interface CompactionReplayGuard extends Disposable {
  readonly storage: Storage;
}

export function createCompactionReplayGuard(
  dbPath: string,
  storage: Storage,
  logger: Logger,
): CompactionReplayGuard {
  const db = new Database(dbPath, { fileMustExist: true });
  db.pragma("busy_timeout = 30000");
  ensureCompactionReplayTable(db);
  const wasCompacted = db.prepare(`
    SELECT 1
    FROM ${COMPACTION_REPLAY_TABLE}
    WHERE "ownerId" = ? AND "timestamp" = ?
  `);
  const deleteOwnerReplayState = db.prepare(`
    DELETE FROM ${COMPACTION_REPLAY_TABLE}
    WHERE "ownerId" = ?
  `);

  const guardedStorage: Storage = {
    ...storage,
    writeMessages: (ownerIdBytes, messages) => async (run) => {
      const ownerId = ownerIdBytesToOwnerId(ownerIdBytes);
      return withOwnerWriteLock(ownerId, async () => {
        const accepted: EncryptedCrdtMessage[] = [];
        let rejectedBytes = 0;
        for (const message of messages) {
          const timestamp = timestampToTimestampBytes(message.timestamp);
          if (wasCompacted.get(Buffer.from(ownerIdBytes), Buffer.from(timestamp))) {
            rejectedBytes += message.change.length;
          } else {
            accepted.push(message);
          }
        }

        const rejectedMessages = messages.length - accepted.length;
        if (rejectedMessages > 0) {
          logger.emit("info", "compaction.replay_filtered", {
            ownerId,
            rejectedMessages,
            rejectedBytes,
            acceptedMessages: accepted.length,
          });
        }
        if (!isNonEmptyArray(accepted)) return ok();
        return await run(storage.writeMessages(ownerIdBytes, accepted));
      });
    },
    deleteOwner: (ownerIdBytes: OwnerIdBytes) => {
      storage.deleteOwner(ownerIdBytes);
      deleteOwnerReplayState.run(Buffer.from(ownerIdBytes));
    },
  };

  return {
    storage: guardedStorage,
    [Symbol.dispose]() {
      db.close();
    },
  };
}
