import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { RelayConfig } from "./config.js";
import type { Logger } from "./logger.js";

const MAX_TRACKED_OWNERS = 10_000;
const PERSIST_INTERVAL_MS = 5 * 60_000;

export interface OwnerTracker {
  trackOwner: (ownerId: string) => boolean;
  persist: () => void;
  stop: () => void;
  getStaleOwners: () => Array<{ ownerId: string; lastSeen: string }>;
  getActivity: () => Record<string, string>;
}

export function createOwnerTracker(
  config: RelayConfig,
  logger: Logger,
): OwnerTracker {
  const sidecarPath = join(config.dataDir, "owner-activity.json");
  const lastSeen = new Map<string, string>();

  try {
    const raw = readFileSync(sidecarPath, "utf8");
    const entries = JSON.parse(raw) as Record<string, string>;
    for (const [id, ts] of Object.entries(entries)) {
      lastSeen.set(id, ts);
    }
    logger.emit("info", "owner_tracker.loaded", { count: lastSeen.size });
  } catch {
    // No file yet — fresh start
  }

  function persist(): void {
    try {
      writeFileSync(
        sidecarPath,
        JSON.stringify(Object.fromEntries(lastSeen), null, 2),
      );
    } catch (e) {
      logger.emit("error", "owner_tracker.persist_failed", {
        error: (e as Error).message,
      });
    }
  }

  const persistTimer = setInterval(persist, PERSIST_INTERVAL_MS);
  persistTimer.unref();

  function trackOwner(ownerId: string): boolean {
    if (lastSeen.size >= MAX_TRACKED_OWNERS && !lastSeen.has(ownerId)) {
      const oldest = lastSeen.keys().next().value;
      if (oldest) lastSeen.delete(oldest);
    }
    lastSeen.set(ownerId, new Date().toISOString());
    return true;
  }

  function getStaleOwners(): Array<{ ownerId: string; lastSeen: string }> {
    const cutoff = Date.now() - config.ownerTtlDays * 86_400_000;
    const stale: Array<{ ownerId: string; lastSeen: string }> = [];
    for (const [id, ts] of lastSeen) {
      if (new Date(ts).getTime() < cutoff) {
        stale.push({ ownerId: id, lastSeen: ts });
      }
    }
    return stale;
  }

  function getActivity(): Record<string, string> {
    return Object.fromEntries(lastSeen);
  }

  function stop(): void {
    clearInterval(persistTimer);
    persist();
  }

  return { trackOwner, persist, stop, getStaleOwners, getActivity };
}
