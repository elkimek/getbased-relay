// Per-owner and global quota management.
//
// Evolu passes `requiredBytes` as the NEW TOTAL for the owner (existing + incoming),
// not a delta. The global check must account for this to avoid double-counting.

import type { RelayConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { Metrics } from "./metrics.js";

export function createQuotaChecker(
  config: RelayConfig,
  logger: Logger,
  metrics: Metrics,
): (ownerId: string, requiredBytes: number) => boolean {
  return function isOwnerWithinQuota(
    ownerId: string,
    requiredBytes: number,
  ): boolean {
    if (requiredBytes > config.quotaPerOwnerBytes) {
      logger.emit("warn", "quota.owner_exceeded", {
        ownerId,
        requiredBytes,
        limitBytes: config.quotaPerOwnerBytes,
      });
      return false;
    }

    let usage;
    try {
      usage = metrics.getQuotaUsage(ownerId);
    } catch (error) {
      logger.emit("error", "quota.usage_unavailable", { error: String(error) });
      return false;
    }
    // This synchronous callback runs immediately before Evolu's synchronous
    // SQLite write transaction. No cached reads or awaits can admit another
    // owner's write between the check and commit in this relay process.
    const projectedUsage = usage.totalStoredBytes - usage.ownerStoredBytes + requiredBytes;
    if (projectedUsage > config.quotaGlobalBytes) {
      logger.emit("warn", "quota.global_exceeded", {
        ownerId,
        requiredBytes,
        globalUsage: usage.totalStoredBytes,
        projectedUsage,
        globalLimit: config.quotaGlobalBytes,
      });
      return false;
    }

    return true;
  };
}
