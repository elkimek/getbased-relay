import { resolve } from "path";

export interface RelayConfig {
  relayPort: number;
  adminPort: number;
  relayName: string;
  dataDir: string;
  quotaPerOwnerBytes: number;
  quotaGlobalBytes: number;
  ownerTtlDays: number;
  logLevel: "debug" | "info" | "warn" | "error";
  logFormat: "json" | "text";
  enableEvoluLogging: boolean;
  adminToken: string | null;
}

function envInt(key: string, fallback: number): number {
  const val = process.env[key];
  if (val === undefined) return fallback;
  const n = parseInt(val, 10);
  if (isNaN(n) || n < 0)
    throw new Error(`${key} must be a non-negative integer, got: ${val}`);
  return n;
}

function envBool(key: string, fallback: boolean): boolean {
  const val = process.env[key];
  if (val === undefined) return fallback;
  return val === "1" || val.toLowerCase() === "true";
}

function envStr(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

export function loadConfig(): RelayConfig {
  const config: RelayConfig = {
    relayPort: envInt("RELAY_PORT", 4000),
    adminPort: envInt("ADMIN_PORT", 4001),
    relayName: envStr("RELAY_NAME", "evolu-relay"),
    dataDir: resolve(envStr("DATA_DIR", "./data")),
    quotaPerOwnerBytes: envInt("QUOTA_PER_OWNER_MB", 10) * 1024 * 1024,
    quotaGlobalBytes: envInt("QUOTA_GLOBAL_MB", 1000) * 1024 * 1024,
    ownerTtlDays: envInt("OWNER_TTL_DAYS", 90),
    logLevel: envStr("LOG_LEVEL", "info") as RelayConfig["logLevel"],
    logFormat: envStr("LOG_FORMAT", "json") as RelayConfig["logFormat"],
    enableEvoluLogging: envBool("ENABLE_EVOLU_LOGGING", false),
    adminToken: process.env.ADMIN_TOKEN || null,
  };

  if (config.relayPort === config.adminPort) {
    throw new Error("RELAY_PORT and ADMIN_PORT must be different");
  }

  return config;
}
