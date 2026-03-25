// quota.js — Per-owner and global quota management

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
      // Metrics DB not ready yet — allow writes
      globalUsageCache = 0;
    }
  }

  return function isOwnerWithinQuota(ownerId, requiredBytes) {
    // Per-owner check
    if (requiredBytes > config.quotaPerOwnerBytes) {
      logger.emit('warn', 'quota.owner_exceeded', {
        ownerId,
        requiredBytes,
        limitBytes: config.quotaPerOwnerBytes,
      });
      return false;
    }

    // Global disk check (cached, refreshed every 60s)
    refreshGlobalUsage();
    if (globalUsageCache + requiredBytes > config.quotaGlobalBytes) {
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
