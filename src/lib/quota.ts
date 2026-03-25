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
  let globalUsageCache = 0;
  let lastGlobalCheck = 0;
  const CACHE_TTL_MS = 60_000;

  function refreshGlobalUsage(): void {
    const now = Date.now();
    if (now - lastGlobalCheck < CACHE_TTL_MS) return;
    lastGlobalCheck = now;
    try {
      globalUsageCache = metrics.getTotalStoredBytes();
    } catch {
      globalUsageCache = 0;
    }
  }

  return function isOwnerWithinQuota(
    ownerId: string,
    requiredBytes: number,
  ): boolean {
    if (requiredBytes >= config.quotaPerOwnerBytes) {
      logger.emit("warn", "quota.owner_exceeded", {
        ownerId,
        requiredBytes,
        limitBytes: config.quotaPerOwnerBytes,
      });
      return false;
    }

    refreshGlobalUsage();
    if (globalUsageCache > config.quotaGlobalBytes) {
      logger.emit("warn", "quota.global_exceeded", {
        ownerId,
        requiredBytes,
        globalUsage: globalUsageCache,
        globalLimit: config.quotaGlobalBytes,
      });
      return false;
    }

    return true;
  };
}
