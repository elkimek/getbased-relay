# getbased-relay

Self-hosted [Evolu](https://github.com/evoluhq/evolu) CRDT relay with structured logging, metrics, and quota management.

Wraps [`@evolu/nodejs`](https://www.npmjs.com/package/@evolu/nodejs) — all sync protocol and CRDT logic is from Evolu. This project adds the operational layer for running a relay in production.

Built for [getbased](https://github.com/elkimek/get-based), a blood work dashboard that uses Evolu for cross-device sync.

## Why

The official Evolu relay works but lacks operational tooling:

- **Logging** is all-or-nothing (silent or raw SQL dump)
- **Quota** is hardcoded at 1MB (too small for real use)
- **No health endpoint** (health probes cause WebSocket errors)
- **No metrics** (can't see owner count, storage usage, connections)

This wrapper fixes all of that without forking the Evolu monorepo.

See [evoluhq/evolu#661](https://github.com/evoluhq/evolu/issues/661) for the full writeup.

## Quick start

### Docker (recommended)

```bash
docker run -d \
  --name relay \
  -p 4000:4000 \
  -p 4001:4001 \
  -v relay-data:/data \
  -e QUOTA_PER_OWNER_MB=10 \
  -e ADMIN_TOKEN=your-secret \
  getbased-relay:latest
```

Or with docker-compose:

```bash
docker compose up -d
```

### Node.js

Requires Node.js >= 22 and TypeScript.

```bash
npm install
npm run build
npm start
```

## Configuration

All settings via environment variables. See [`.env.example`](.env.example) for the full list.

| Variable | Default | Description |
|---|---|---|
| `RELAY_PORT` | `4000` | Evolu WebSocket relay port |
| `ADMIN_PORT` | `4001` | Health/metrics HTTP port |
| `QUOTA_PER_OWNER_MB` | `10` | Max stored bytes per identity |
| `QUOTA_GLOBAL_MB` | `1000` | Max total stored bytes |
| `OWNER_TTL_DAYS` | `90` | Days before owner flagged as stale |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `LOG_FORMAT` | `json` | `json` or `text` |
| `ADMIN_TOKEN` | *(none)* | Bearer token for `/metrics` (omit for open access) |

## Endpoints

**Relay port** (default 4000) — Evolu WebSocket sync. Connect your Evolu client with:

```javascript
transports: [{ type: "WebSocket", url: "wss://your-relay.example.com" }]
```

**Admin port** (default 4001, localhost only) — HTTP endpoints:

- `GET /health` — Always public. Returns `{"status":"ok","uptime":...}`
- `GET /metrics` — Requires `Authorization: Bearer <ADMIN_TOKEN>` if configured. Returns owner count, per-owner storage, DB size, connection count, quota settings.

## Reverse proxy

The relay port serves WebSocket only. Use Caddy or nginx for TLS termination:

```
# Caddyfile
sync.example.com {
    reverse_proxy localhost:4000
}
```

The admin port binds to `127.0.0.1` — access it via SSH tunnel or add a proxied route.

## Architecture

```
                          ┌─────────────────────────┐
                          │     getbased-relay       │
                          │                          │
  Evolu clients ──WSS──▶  │  :4000  @evolu/nodejs    │──▶  SQLite DB
                          │         (CRDT relay)     │     (/data/*.db)
                          │                          │
  Uptime monitors ─HTTP─▶ │  :4001  Admin server     │──▶  Read-only queries
                          │         (/health,/metrics)│
                          └─────────────────────────┘
```

- **src/index.ts** — Entry point, wiring, signal handlers
- **src/lib/config.ts** — Env var parsing with defaults and typed `RelayConfig` interface
- **src/lib/logger.ts** — Custom Console that intercepts Evolu's 17 relay events, emits structured JSON at configurable levels
- **src/lib/quota.ts** — Per-owner + global disk quota via `isOwnerWithinQuota` callback
- **src/lib/owner-tracker.ts** — Last-seen tracking via relay subscribe events, persisted to sidecar file
- **src/lib/metrics.ts** — Read-only SQLite queries against the relay DB
- **src/lib/admin-server.ts** — HTTP server for `/health` and `/metrics`, timing-safe token auth
- **src/lib/startup-check.ts** — DB integrity validation on boot (magic bytes, PRAGMA check, table audit)

## Credits

Built on [Evolu](https://github.com/evoluhq/evolu) by [Daniel Steigerwald](https://github.com/steida). All sync protocol, CRDT logic, and SQLite storage are from Evolu — this project only adds the operational wrapper.

## License

MIT
