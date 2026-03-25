// owner-tracker.js — Track owner last-seen timestamps via isOwnerAllowed hook

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export function createOwnerTracker(config, logger) {
  const sidecarPath = join(config.dataDir, 'owner-activity.json');
  const lastSeen = new Map();

  // Load persisted activity on startup
  try {
    const raw = readFileSync(sidecarPath, 'utf8');
    const entries = JSON.parse(raw);
    for (const [id, ts] of Object.entries(entries)) {
      lastSeen.set(id, ts);
    }
    logger.emit('info', 'owner_tracker.loaded', { count: lastSeen.size });
  } catch {
    // No file yet — fresh start
  }

  function persist() {
    try {
      const obj = Object.fromEntries(lastSeen);
      writeFileSync(sidecarPath, JSON.stringify(obj, null, 2));
    } catch (e) {
      logger.emit('error', 'owner_tracker.persist_failed', { error: e.message });
    }
  }

  // isOwnerAllowed callback — always allows, but records activity
  function isOwnerAllowed(ownerId) {
    lastSeen.set(ownerId, new Date().toISOString());
    return true;
  }

  function getStaleOwners() {
    const cutoff = Date.now() - config.ownerTtlDays * 86_400_000;
    const stale = [];
    for (const [id, ts] of lastSeen) {
      if (new Date(ts).getTime() < cutoff) {
        stale.push({ ownerId: id, lastSeen: ts });
      }
    }
    return stale;
  }

  function getActivity() {
    return Object.fromEntries(lastSeen);
  }

  return { isOwnerAllowed, persist, getStaleOwners, getActivity };
}
