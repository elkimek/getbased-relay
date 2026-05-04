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
| `SELF_PORT` | `4003` | Owner-scoped self-service HTTP port |
| `SELF_BIND` | `0.0.0.0` | Bind address for self-service port |
| `SELF_ENABLED` | `true` | Set `false` to disable `/self/*` endpoints |
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
- `POST /compact-owner?ownerId=<base64url-22-char>` — Requires `Authorization: Bearer <ADMIN_TOKEN>`. Drops every `evolu_message` row for the given owner and resets `evolu_usage.storedBytes` to 0. Use when an owner has hit the per-owner quota (`quota.owner_exceeded` warnings) — the running counter never decrements on its own (Evolu has no built-in compaction). Clients keep their full state in localStorage; the next push from each device re-establishes the owner's CRDT state on the relay. Response body: `{ownerId, deletedMessages, beforeStoredBytes, afterStoredBytes}`.

**Self-service port** (default 4003) — owner-scoped HTTP endpoints, signed with the client's own writeKey. No admin token; one user can never act on another user's owner. Intended to be exposed via the same reverse proxy as the relay port.

- `POST /self/compact-owner` — Body: `{ownerId, timestamp, signature}`. Same effect as `/compact-owner` but client-driven; lets users unwedge themselves when they hit the per-owner quota without round-tripping through the operator. Replaces what was previously a manual SSH-and-curl runbook.
- `GET /self/owner-storage?ownerId=...&timestamp=...&signature=...` — Returns `{ownerId, storedBytes, quotaBytes}` straight from `evolu_usage` for that owner. Use this to show users an accurate quota readout instead of a cumulative client-side estimate (which drifts the moment compaction runs).

**Auth scheme.** `signature = HMAC-SHA256(writeKey, "{context}:{ownerId}:{timestamp}").hex()` where `context` is `"compact"` or `"storage"`. The relay looks up the writeKey in its `evolu_writeKey` table (the same secret the Evolu client already holds for pushes), recomputes the HMAC, and timing-safe-compares. The timestamp must be within ±5 minutes of server time. All auth failures return a uniform `401 unauthorized` to avoid an owner-existence oracle.

**Rate limit.** Per-IP token bucket caps `/self/compact-owner` at 10 requests/minute and `/self/owner-storage` at 60 requests/minute. Excess returns `429` with a `Retry-After` header. When the relay is behind a reverse proxy on the same host (peer = loopback), the limiter trusts the leftmost `X-Forwarded-For` entry; otherwise it uses the socket peer. Caddy's `reverse_proxy` directive sets `X-Forwarded-For` automatically, so no extra config is needed.

**Log coalescing.** Repeated unauthorized requests with the same `(ownerId, IP, reason)` are logged once on first occurrence; further hits within 60 s suppress, and a `self.coalesced_unauthorized` summary fires on window expiry if the count exceeded 1. Stops a flood from filling the log without losing the first signal of any abuse pattern.

## Reverse proxy

The relay port serves WebSocket only. Use Caddy or nginx for TLS termination:

```
# Caddyfile
sync.example.com {
    reverse_proxy localhost:4000
}

self.example.com {
    reverse_proxy localhost:4003
}
```

The admin port binds to `127.0.0.1` — access it via SSH tunnel or add a proxied route. The self-service port can be exposed publicly: every endpoint is HMAC-authed against per-owner writeKeys, no admin secret involved.

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

## Context Gateway

A simple HTTP API that stores per-profile lab context behind token auth. MCP servers and bot plugins use it to query health data on behalf of messenger/bot interfaces. Runs alongside the Evolu relay as a separate service.

### How it works

Each authenticated token gets a JSON file in `/opt/context-gateway/data/` (filename is a hash of the token). Context is stored per-profile, so multiple profiles can coexist under the same token. The format is backward-compatible with the old single-context layout — existing files are migrated on first write.

### Endpoints

All endpoints require `Authorization: Bearer <token>`.

| Method | Path | Description |
|---|---|---|
| `POST /api/context` | — | Push context. Body: `{ context, profileId, profiles }` |
| `GET /api/context` | — | Get the default profile's context |
| `GET /api/context?profile=<id>` | — | Get a specific profile's context |

### Docker Compose

The `docker-compose.yml` runs both services:

| Service | Port | Purpose |
|---|---|---|
| Evolu relay | `:4000` | CRDT sync (WebSocket) |
| Context gateway | `:4001` | Lab context API (HTTP) |

```bash
docker compose up -d
```

## Credits

Built on [Evolu](https://github.com/evoluhq/evolu) by [Daniel Steigerwald](https://github.com/steida). All sync protocol, CRDT logic, and SQLite storage are from Evolu — this project only adds the operational wrapper.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).

If you run a modified version of this relay as a network service, AGPLv3 §13 requires you to offer your users the corresponding source.
