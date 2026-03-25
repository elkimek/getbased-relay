// config.js — Environment variable configuration with defaults

import { resolve } from 'path';

function envInt(key, fallback) {
  const val = process.env[key];
  if (val === undefined) return fallback;
  const n = parseInt(val, 10);
  if (isNaN(n) || n < 0) throw new Error(`${key} must be a non-negative integer, got: ${val}`);
  return n;
}

function envBool(key, fallback) {
  const val = process.env[key];
  if (val === undefined) return fallback;
  return val === '1' || val.toLowerCase() === 'true';
}

function envStr(key, fallback) {
  return process.env[key] || fallback;
}

export function loadConfig() {
  const config = {
    // Ports
    relayPort:      envInt('RELAY_PORT', 4000),
    adminPort:      envInt('ADMIN_PORT', 4001),

    // Storage
    relayName:      envStr('RELAY_NAME', 'evolu-relay'),
    dataDir:        resolve(envStr('DATA_DIR', './data')),

    // Quotas
    quotaPerOwnerBytes: envInt('QUOTA_PER_OWNER_MB', 10) * 1024 * 1024,
    quotaGlobalBytes:   envInt('QUOTA_GLOBAL_MB', 1000) * 1024 * 1024,

    // Owner lifecycle
    ownerTtlDays:   envInt('OWNER_TTL_DAYS', 90),

    // Logging
    logLevel:       envStr('LOG_LEVEL', 'info'),
    logFormat:      envStr('LOG_FORMAT', 'json'),
    enableEvoluLogging: envBool('ENABLE_EVOLU_LOGGING', false),

    // Admin auth
    adminToken:     process.env.ADMIN_TOKEN || null,
  };

  // Validate
  if (config.relayPort === config.adminPort) {
    throw new Error('RELAY_PORT and ADMIN_PORT must be different');
  }

  return config;
}
