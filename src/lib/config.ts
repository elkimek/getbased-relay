import { resolve } from "path";

export interface RelayConfig {
  relayPort: number;
  adminPort: number;
  selfPort: number;
  selfBind: string;
  selfEnabled: boolean;
  contextVerifierPort: number;
  contextVerifierBind: string;
  contextVerifierSocket: string | null;
  contextVerifierEnabled: boolean;
  contextVerifierToken: string | null;
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
    //
    // Bind defaults to 127.0.0.1 — the safe default. Operators who want
    // to expose the port directly to the public internet (instead of
    // proxying through Caddy/nginx) must explicitly set SELF_BIND=0.0.0.0
    // and accept the surface area. The HMAC + rate limit cap the worst
    // case but a localhost-only default removes the foot-gun for
    // someone who copy-pastes the compose file without reading the README.
    selfPort: envInt("SELF_PORT", 4003),
    selfBind: envStr("SELF_BIND", "127.0.0.1"),
    selfEnabled: envBool("SELF_ENABLED", true),
    // Private verification oracle for the optional context gateway. It
    // deliberately returns only yes/no so the gateway never needs the relay
    // database (and therefore can never read every owner's write key).
    // Disabled by default; the compose deployment enables it on a shared
    // Unix socket protected by a separate bearer token.
    contextVerifierPort: envInt("CONTEXT_VERIFIER_PORT", 4004),
    contextVerifierBind: envStr("CONTEXT_VERIFIER_BIND", "127.0.0.1"),
    contextVerifierSocket: process.env.CONTEXT_VERIFIER_SOCKET || null,
    contextVerifierEnabled: envBool("CONTEXT_VERIFIER_ENABLED", false),
    contextVerifierToken: process.env.CONTEXT_VERIFIER_TOKEN || null,
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
  if (config.contextVerifierEnabled) {
    if (!config.contextVerifierToken) {
      throw new Error(
        "CONTEXT_VERIFIER_TOKEN is required when CONTEXT_VERIFIER_ENABLED=true",
      );
    }
    if (
      !config.contextVerifierSocket &&
      (
        config.contextVerifierPort === config.relayPort ||
        config.contextVerifierPort === config.adminPort ||
        (config.selfEnabled && config.contextVerifierPort === config.selfPort)
      )
    ) {
      throw new Error(
        "CONTEXT_VERIFIER_PORT must differ from RELAY_PORT, ADMIN_PORT, and SELF_PORT",
      );
    }
  }

  return config;
}
