import { resolve } from "path";

export interface RelayConfig {
  relayPort: number;
  adminPort: number;
  selfPort: number;
  selfBind: string;
  selfEnabled: boolean;
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
    // Self-service endpoints (HMAC-authed, owner-scoped). Default-on
    // since they're harmless without an existing client + writeKey, but
    // operators can hard-disable with SELF_ENABLED=0 if they prefer to
    // route everything through the admin token.
    selfPort: envInt("SELF_PORT", 4003),
    selfBind: envStr("SELF_BIND", "0.0.0.0"),
    selfEnabled: envBool("SELF_ENABLED", true),
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
  if (config.selfEnabled) {
    if (config.selfPort === config.relayPort || config.selfPort === config.adminPort) {
      throw new Error("SELF_PORT must differ from RELAY_PORT and ADMIN_PORT");
    }
  }

  return config;
}
