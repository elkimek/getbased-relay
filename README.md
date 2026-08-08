# getbased-relay

Self-hosted [Evolu](https://github.com/evoluhq/evolu) CRDT relay for getbased sync, with structured logging, metrics, quota management, owner self-service endpoints, and the optional Agent Access context gateway.

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
| `SELF_BIND` | `127.0.0.1` | Bind address for self-service port (set to `0.0.0.0` to expose directly without a reverse proxy) |
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
- `GET /metrics` — Requires the admin bearer token when `ADMIN_TOKEN` is configured. Returns owner count, per-owner storage, DB size, connection count, and quota settings.
- `POST /compact-owner?ownerId=<base64url-22-char>` — Requires the admin bearer token. Drops every relay message and the usage row for the owner. Use when an owner has hit the per-owner quota (`quota.owner_exceeded` warnings). This is a coordinated reset: stop and reset every paired client first, then rebuild one fresh snapshot from canonical application storage. Any client retaining the old Evolu history can upload it again. Response body: `{ownerId, deletedMessages, beforeStoredBytes, afterStoredBytes}`.

**Self-service port** (default 4003) — owner-scoped HTTP endpoints, signed with the client's own writeKey. No admin token; one user can never act on another user's owner. Intended to be exposed via the same reverse proxy as the relay port.

- `POST /self/compact-owner` — Body: `{ownerId, timestamp, signature}`. Same coordinated-reset requirement as `/compact-owner`, but client-driven; every paired client must discard its old Evolu history before one client rebuilds a fresh snapshot.
- `GET /self/owner-storage?ownerId=...&timestamp=...&signature=...` — Returns `{ownerId, storedBytes, quotaBytes}` straight from `evolu_usage` for that owner. Use this to show users an accurate quota readout instead of a cumulative client-side estimate (which drifts the moment compaction runs).

**Auth scheme.** `signature = HMAC-SHA256(writeKey, "{context}:{ownerId}:{timestamp}").hex()` where `context` is `"compact"` or `"storage"`. The relay looks up the writeKey in its `evolu_writeKey` table (the same secret the Evolu client already holds for pushes), recomputes the HMAC, and timing-safe-compares. The timestamp must be within ±5 minutes of server time. All auth failures return a uniform `401 unauthorized` to avoid an owner-existence oracle.

**Rate limit.** Per-IP token bucket caps `/self/compact-owner` at 10 requests/minute and `/self/owner-storage` at 60 requests/minute. Excess returns `429` with a `Retry-After` header. When the relay is behind a reverse proxy on the same host (peer = loopback), the limiter trusts the leftmost `X-Forwarded-For` entry; otherwise it uses the socket peer. Caddy's `reverse_proxy` directive sets `X-Forwarded-For` automatically, so no extra config is needed.

**Log coalescing.** Repeated unauthorized requests with the same `(ownerId, IP, reason)` are logged once on first occurrence; further hits within 60 s suppress, and a `self.coalesced_unauthorized` summary fires on window expiry if the count exceeded 1. Stops a flood from filling the log without losing the first signal of any abuse pattern.

## Reverse proxy

The relay port serves WebSocket only. Use Caddy or nginx for TLS termination:

```
# Caddyfile — option A: dedicated subdomain per surface
sync.example.com {
    reverse_proxy localhost:4000
}

self.example.com {
    reverse_proxy localhost:4003
}
```

```
# Caddyfile — option B: single hostname, path-routing (what sync.getbased.health uses)
sync.example.com {
    handle /self/* {
        reverse_proxy 127.0.0.1:4003
    }
    handle {
        reverse_proxy 127.0.0.1:4000
    }
}
```

Both patterns work; the client (`get-based`) derives `https://<relay-hostname>/self/...` from the WebSocket URL by default. For self-hosters who want to skip the reverse proxy entirely (expose port 4003 directly to the internet), set `SELF_BIND=0.0.0.0` and have clients hard-code their own URL via the `labcharts-self-url` localStorage override.

The admin port binds to `127.0.0.1` — access it via SSH tunnel or add a proxied route. The self-service port defaults to `127.0.0.1` too; both expect a reverse proxy in front. Every `/self/*` endpoint is HMAC-authed against per-owner writeKeys, so it's safe to expose publicly once the reverse proxy is wired.

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

HTTP API for Agent Access. MCP servers and bot plugins use it to fetch encrypted, browser-rendered getbased context for an external AI assistant. Runs alongside the Evolu relay as a separate service.

### How it works

Agent Access storage is owner-bound, not token-bound:

- the browser encrypts context locally before upload;
- the bearer token is only a read capability;
- every write is HMAC-signed with the Evolu owner's `writeKey`;
- the gateway looks up that write key in the relay SQLite DB and stores context under `/owners/<ownerId>.json`;
- token hashes map to owner IDs in `agent-token-map.json`;
- per-owner limits cap profiles, active tokens, per-profile payload size, and total Agent Access storage.

This prevents users from bypassing relay quota by generating unlimited random Agent Access tokens. Legacy token-hash files remain readable during rollout, but new writes require owner proof.

### Endpoints

All endpoints require an Agent Access bearer token in the `Authorization` header.

| Method | Path | Description |
|---|---|---|
| `POST /api/context` | — | Push encrypted context. Body: `{ ownerId, timestamp, signature, context, profileId }`. Signature is `HMAC-SHA256(writeKey, "agent-context:{ownerId}:{timestamp}:{sha256(token)}:{profileId}:{sha256(context)}")`. |
| `GET /api/context` | — | Get the default profile's encrypted context for this token's owner mapping |
| `GET /api/context?profile=<id>` | — | Get a specific profile's encrypted context |
| `DELETE /api/context` | — | Revoke this token's owner mapping, signed with the same owner proof over an empty context |

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
