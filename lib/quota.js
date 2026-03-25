// quota.js — Per-owner and global quota management
//
// Evolu passes `requiredBytes` as the NEW TOTAL for the owner (existing + incoming),
// not a delta. The global check must account for this to avoid double-counting.

export function createQuotaChecker(config, logger, metrics) {
  let globalUsageCache = 0;
  let lastGlobalCheck = 0;
  const CACHE_TTL_MS = 60_000;

  function refreshGlobalUsage() {
    const now = Date.now();
    if (now - lastGlobalCheck < CACHE_TTL_MS) return;
    lastGlobalCheck = now;
    try {
      globalUsageCache = metrics?.getTotalStoredBytes() ?? 0;
    } catch {
      globalUsageCache = 0;
    }
  }

  return function isOwnerWithinQuota(ownerId, requiredBytes) {
    // Per-owner check: requiredBytes is the new total for this owner
    if (requiredBytes >= config.quotaPerOwnerBytes) {
      logger.emit('warn', 'quota.owner_exceeded', {
        ownerId,
        requiredBytes,
        limitBytes: config.quotaPerOwnerBytes,
      });
      return false;
    }

    // Global check: globalUsageCache already includes this owner's current bytes.
    // Just check if total usage is under the limit.
    refreshGlobalUsage();
    if (globalUsageCache > config.quotaGlobalBytes) {
      logger.emit('warn', 'quota.global_exceeded', {
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
