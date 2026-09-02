# getbased-relay

Self-hosted [Evolu](https://github.com/evoluhq/evolu) CRDT relay for getbased sync, with structured logging, metrics, quota management, owner self-service endpoints, and the optional Agent Access context gateway.

Wraps [`@evolu/nodejs`](https://www.npmjs.com/package/@evolu/nodejs) — all sync protocol and CRDT logic is from Evolu. This project adds the operational layer for running a relay in production.

Built for [getbased](https://github.com/elkimek/get-based), a blood work dashboard that uses Evolu for cross-device sync.

## Evolu compatibility

Evolu is an npm dependency here, not vendored source. The v2 relay targets the latest Evolu 8 packages: `@evolu/common` 8.9.0 and `@evolu/nodejs` 3.2.0. The ranges in `package.json` permit compatible updates within those majors; `package-lock.json` pins the exact versions used by `npm ci` and the Docker build.

| Relay | `@evolu/common` | `@evolu/nodejs` | Node.js |
|---|---:|---:|---:|
| v2.0.0 | `^8.9.0` (locked to 8.9.0) | `^3.2.0` (locked to 3.2.0) | >= 24.20.0 |
| v1.2.3 | `^7.4.0` | `^2.4.0` | >= 22.0.0 |

The package version streams are independent: Evolu 8 uses the 8.x `common` package and the 3.x `nodejs` adapter.

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
git clone https://github.com/elkimek/getbased-relay.git
cd getbased-relay
docker build -t getbased-relay:latest .
docker run -d \
  --name relay \
  -p 127.0.0.1:4000:4000 \
  -p 127.0.0.1:4003:4003 \
  -v relay-data:/data \
  -e SELF_BIND=0.0.0.0 \
  -e QUOTA_PER_OWNER_MB=10 \
  -e ADMIN_TOKEN=your-secret \
  getbased-relay:latest
```

Or run the relay and Context Gateway together with Docker Compose. Copy `.env.example`, replace the blank `CONTEXT_VERIFIER_TOKEN` with the output of `openssl rand -hex 32`, then start the stack:

```bash
cp .env.example .env
docker compose up -d --build
```

### Node.js

Requires Node.js >= 24.20.0. TypeScript is installed as a development dependency.

```bash
npm ci
npm run build
npm start
```

## Configuration

All settings via environment variables. See [`.env.example`](.env.example) for the full list.

| Variable | Default | Description |
|---|---|---|
| `RELAY_PORT` | `4000` | Evolu WebSocket relay port |
| `ADMIN_PORT` | `4001` | Health/metrics HTTP port (the supplied Compose stack overrides this to internal port `4002`) |
| `SELF_PORT` | `4003` | Owner-scoped self-service HTTP port |
| `SELF_BIND` | `127.0.0.1` | Bind address for self-service port (set to `0.0.0.0` to expose directly without a reverse proxy) |
| `SELF_ENABLED` | `true` | Set `false` to disable `/self/*` endpoints |
| `CONTEXT_VERIFIER_PORT` | `4004` | Private Agent Access proof-verification port |
| `CONTEXT_VERIFIER_BIND` | `127.0.0.1` | Verifier TCP bind address when a Unix socket is not configured |
| `CONTEXT_VERIFIER_SOCKET` | *(none)* | Unix socket path; takes precedence over TCP and is used by the supplied compose deployment |
| `CONTEXT_VERIFIER_ENABLED` | `false` | Enables the private verifier; compose enables it for Context Gateway |
| `CONTEXT_VERIFIER_TOKEN` | *(none)* | Required separate bearer when the private verifier is enabled |
| `RELAY_NAME` | `evolu-relay` | SQLite database filename, without `.db` |
| `DATA_DIR` | `./data` | Relay database and metadata directory |
| `QUOTA_PER_OWNER_MB` | `10` | Max stored bytes per identity |
| `QUOTA_GLOBAL_MB` | `1000` | Max total stored bytes |
| `OWNER_TTL_DAYS` | `90` | Days before owner flagged as stale |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `LOG_FORMAT` | `json` | `json` or `text` |
| `ENABLE_EVOLU_LOGGING` | `false` | Enables Evolu's very verbose raw CRDT/SQL logs |
| `ADMIN_TOKEN` | *(none)* | Bearer token for `/metrics`; required for `/compact-owner` |

## Endpoints

**Relay port** (default 4000) — Evolu WebSocket sync. Connect your Evolu client with:

```javascript
transports: [{ type: "WebSocket", url: "wss://your-relay.example.com" }]
```

**Admin port** (default 4001, localhost only) — HTTP endpoints:

- `GET /health` — Always public. Returns `{"status":"ok","uptime":...}`
- `GET /metrics` — Requires the admin bearer token when `ADMIN_TOKEN` is configured. Returns owner count, per-owner storage, DB size, connection count, and quota settings.
- `POST /compact-owner?ownerId=<base64url-22-char>` — Requires the admin bearer token. Replaces every relay message with a small exact-timestamp replay tombstone and clears the owner's live usage. A stale or offline paired client can reconnect safely: replayed history is acknowledged but not stored, while timestamps the relay has never compacted remain valid new writes. Response body: `{ownerId, deletedMessages, protectedTimestamps, beforeStoredBytes, afterStoredBytes}`.

**Self-service port** (default 4003) — owner-scoped HTTP endpoints, signed with the client's own writeKey. No admin token; one user can never act on another user's owner. Intended to be exposed via the same reverse proxy as the relay port.

- `POST /self/compact-owner` — Body: `{ownerId, timestamp, signature}`. Same replay-protected compaction as `/compact-owner`, but client-driven. Sync each device's latest changes first so the chosen canonical device has current application data; offline devices no longer need to discard their local Evolu history before reconnecting.
- `GET /self/owner-storage?ownerId=...&timestamp=...&signature=...` — Returns `{ownerId, storedBytes, quotaBytes, messageCount, lastWriteToken}` from the live relay database. Besides an accurate quota readout, `messageCount` and `lastWriteToken` let a client confirm that a push was actually persisted.

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

The admin port always binds to process-local `127.0.0.1`. A native Node.js deployment can reach it through an SSH tunnel; in the supplied Compose stack it stays container-only on port 4002 and can be queried with `docker compose exec relay`. The self-service port defaults to `127.0.0.1` too; container deployments explicitly bind it to `0.0.0.0` inside the container while publishing only to host loopback for the reverse proxy. Every `/self/*` endpoint is HMAC-authenticated against per-owner write keys.

## Architecture

```text
Evolu clients ──WSS──▶ :4000 relay + replay filter ─────────▶ relay SQLite DB
Owner clients ─HTTPS─▶ :4003 /self/* ───────────────────────▶ owner-scoped DB operations
Operator      ──HTTP─▶ :4001 admin (Compose: internal :4002)▶ health, metrics, compaction

AI assistants ─HTTPS─▶ :4001 Context Gateway ──Unix socket─▶ private owner-proof verifier
                              │                                  │
                              └── encrypted context files        └── yes/no only; no key export
```

- **src/index.ts** — Entry point, wiring, signal handlers
- **src/lib/config.ts** — Env var parsing with defaults and typed `RelayConfig` interface
- **src/lib/logger.ts** — Custom Console that intercepts Evolu's 17 relay events, emits structured JSON at configurable levels
- **src/lib/quota.ts** — Per-owner + global disk quota via `isOwnerWithinQuota` callback
- **src/lib/compact-owner.ts** — Atomic owner compaction shared by admin and self-service routes
- **src/lib/compaction-replay.ts** — Exact-timestamp tombstones that prevent stale devices from refilling compacted relay history
- **src/lib/replay-protected-relay.ts** — Evolu Node/WebSocket adapter with the replay-filtered storage wrapper
- **src/lib/owner-write-lock.ts** — Same-owner serialization between relay writes and compaction
- **src/lib/owner-tracker.ts** — Last-seen tracking via relay subscribe events, persisted to sidecar file
- **src/lib/metrics.ts** — Read-only SQLite queries against the relay DB
- **src/lib/admin-server.ts** — Local HTTP server for health, metrics, and admin compaction
- **src/lib/self-server.ts** — HMAC-authenticated, owner-scoped storage and compaction endpoints
- **src/lib/context-verifier-server.ts** — Private yes/no owner-proof verifier for Agent Access
- **src/lib/startup-check.ts** — DB integrity validation on boot (magic bytes, PRAGMA check, table audit)
- **context-gateway/server.js** — Encrypted Agent Access storage, quotas, and token-to-owner mapping

## Context Gateway

HTTP API for Agent Access. MCP servers and bot plugins use it to fetch encrypted, browser-rendered getbased context for an external AI assistant. Runs alongside the Evolu relay as a separate service.

### How it works

Agent Access context storage is owner-bound. Proposal queues are owner-mapped and token-scoped:

- the browser encrypts context locally before upload;
- the bearer token authorizes context reads and ciphertext proposal submission for its already mapped owner;
- every context write is HMAC-signed with the Evolu owner's `writeKey`; proposal submission cannot create or change an owner mapping;
- the gateway sends context-write proofs to a private relay verifier that returns only yes/no; the gateway never mounts the relay database and never receives a write key;
- token hashes map to owner IDs in `agent-token-map.json`;
- per-owner limits cap profiles, active tokens, per-profile payload size, and total Agent Access storage.
- proposal records contain only a strict AES-GCM envelope plus opaque proposal ID and server timestamp; the gateway never receives action plaintext;
- each proposal ID is deterministically derived from its random AES-GCM IV, and the envelope key ID must match a context key already registered by the owner-signed browser context;
- proposal IDs are idempotent per token, queues are bounded, and old records expire automatically;
- retained proposal IDs are bounded both per token and owner-wide: the owner-wide ceiling is derived from serialized receipt bytes and always reserves one maximum-size encrypted context inside the owner storage quota.

This prevents users from bypassing relay quota by generating unlimited random Agent Access tokens. Legacy token-hash files remain readable during rollout, but new writes require owner proof.

The verifier listens on a shared Unix socket and requires a
separate `CONTEXT_VERIFIER_TOKEN`. Generate that deployment token with
`openssl rand -hex 32`; it is an internal caller credential, not an Evolu
owner key. The public Agent Access protocol and browser HMAC format are
unchanged.

The supplied Context Gateway limiter keys on a dedicated
`X-Getbased-Client-IP` header rather than `X-Forwarded-For`. The reverse proxy
must overwrite it from the actual socket peer:

```caddyfile
handle /api/* {
    reverse_proxy 127.0.0.1:4001 {
        header_up X-Getbased-Client-IP {http.request.remote.host}
    }
}
```

### Endpoints

All endpoints require an Agent Access bearer token in the `Authorization` header.

| Method | Path | Description |
|---|---|---|
| `POST /api/context` | — | Push encrypted context. Body: `{ ownerId, timestamp, signature, context, profileId }`. Signature is `HMAC-SHA256(writeKey, "agent-context:{ownerId}:{timestamp}:{sha256(token)}:{profileId}:{sha256(context)}")`. |
| `GET /api/context` | — | Get the default profile's encrypted context for this token's owner mapping |
| `GET /api/context?profile=<id>` | — | Get a specific profile's encrypted context |
| `DELETE /api/context` | — | Revoke this token's owner mapping, signed with the same owner proof over an empty context |
| `POST /api/agent-proposals` | — | Queue a strict ciphertext envelope for browser review. The opaque proposal ID must match the envelope IV and the key ID must already belong to this owner. Idempotent retries are accepted; conflicting retries are rejected. |
| `GET /api/agent-proposals` | — | List this token's pending ciphertext envelopes |
| `DELETE /api/agent-proposals/<proposalId>` | — | Acknowledge one proposal after durable browser ingestion |

Proposal submission is not an execution API. The browser decrypts the envelope locally, revalidates profile, capability, expiry, action schema, and replay state, then requires explicit user approval before invoking an app-owned action.

Proposal limits are configured with `AGENT_PROPOSAL_MAX_CIPHERTEXT_BYTES` (default 64 KiB ciphertext), `AGENT_PROPOSAL_MAX_PENDING` (default 20 pending per token), `AGENT_PROPOSAL_MAX_TRACKED` (default 256 pending plus acknowledged IDs per token), and `AGENT_PROPOSAL_RETENTION_MS` (default 24 hours). The tracked-ID bound prevents an authorized token from cycling queue and acknowledgement requests until replay receipts consume the owner's shared storage quota.

### Docker Compose

The `docker-compose.yml` runs both services and keeps private surfaces off the public interface:

| Service | Port | Purpose |
|---|---|---|
| Evolu relay | host `127.0.0.1:4000` | CRDT sync (WebSocket), intended for reverse proxying |
| Context gateway | host `127.0.0.1:4001` | Agent Access context API, intended for reverse proxying |
| Relay self-service | host `127.0.0.1:4003` | Owner-scoped storage and compaction API |
| Relay admin | container-only `:4002` | Health, metrics, and operator compaction |
| Private verifier | Unix socket | Internal yes/no owner-proof verification; no listening TCP port |

```bash
docker compose up -d
```

## Releases

See [CHANGELOG.md](CHANGELOG.md) for the versioned history and upgrade notes. GitHub release pages should be cut from the matching version commit; the package version, changelog entry, and tag must agree.

## Credits

Built on [Evolu](https://github.com/evoluhq/evolu) by [Daniel Steigerwald](https://github.com/steida). All sync protocol, CRDT logic, and SQLite storage are from Evolu — this project only adds the operational wrapper.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).

If you run a modified version of this relay as a network service, AGPLv3 §13 requires you to offer your users the corresponding source.
