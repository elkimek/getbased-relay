# Changelog

Notable changes to getbased-relay are documented here. The project follows Semantic Versioning.

## Unreleased

### Changed

- Pin `@evolu/common` 8.24.1 and `@evolu/nodejs` 4.4.3 together, adopting Evolu's SQLite 3.54.1 core, native timestamp storage, and prebuilt Node addon. Remove obsolete optional tooling peer overrides.
- Retain the direct `better-sqlite3` dependency for getbased's operational helpers, owner proofs, metrics, and compaction.

### Fixed

- A stale device with compacted history repeatedly uploaded discarded messages on later synchronization rounds. Reconciliation now acknowledges proven replay timestamps for that WebSocket connection only. Fresh devices still receive only live rebuilt history, and discarded payloads remain absent.
- Release per-connection replay acknowledgements on disconnect and owner deletion.
- Serve each connection's requests in arrival order, yield between requests, pause reads while serving, and wait for each reply write before accepting more work. A slow quota callback no longer lets later requests overtake it, and a peer that stops reading cannot queue unlimited replies.
- Keep paused connections alive during heartbeat checks; retain replay-filtered broadcasts, per-owner locks and broadcast backlog limits.
- Log invalid protocol requests at debug level without raw frame bytes, and cancel queued request work when a connection closes.

### Added

- Public `GET` and `HEAD /health` on the WebSocket port, reporting database-schema readability; other HTTP requests receive 426. The private admin health endpoint retains its stronger required-table and replay-readiness checks.
- Regression coverage for request ordering, reply backpressure, connection-close cancellation with a held reply, heartbeat progress, public health, and opening a synthetic 2.0.2 database while preserving keys, stored messages and compaction tombstones. Migrate compaction tests to `createNodeJsSqliteDriver`.

### Upgrade notes

- Back up the relay volume and retain the previous image before deployment. Rebuild with `npm ci` and `npm run build`, or rebuild the relay image. Preserve the database volume, owner keys, environment settings and existing HTTP/proxy routes; no database conversion or browser package update is required.
- The native addon supports Linux (glibc >=2.28 or musl) and macOS >=13.5 on x64 and arm64; native Windows execution is no longer available.
- Keep Node.js >=24.20.0; the Docker image remains pinned to Node.js 24.21.0. Native build tools are still needed for the retained operational SQLite dependency. Validate the new relay with current app clients before updating the browser packages.

## [2.0.2] - 2026-10-13

### Security

- Update Evolu's protocol validation to reject malformed sync requests before storing, subscribing, or broadcasting, including encrypted changes shorter than 41 bytes, invalid flags, and invalid or oversized ranges. This prevents malformed-message memory pressure and short-change quota bypasses.

### Fixed

- Incorporate Evolu's fixes for sync failures when protocol messages are nearly full and endless retries on stored changes too large for a message. Oversized changes remain stored but are skipped during reconciliation.
- Roll back failed SQLite writes and return a protocol write error without broadcasting the failed changes. The service remains running and can resume writes after storage is repaired, instead of repeatedly crashing on the same write.
- Update the WebSocket dependency with the fix that validates close arguments before changing the connection state.

### Changed

- Lock `@evolu/common` to 8.18.0 and `@evolu/nodejs` to 4.2.0; require common 8.18.0 or later within the same major.
- Update `ws` to 8.22.0 and Node.js development types to 24.19.1.
- Refresh both pinned Node.js 24.21.0 LTS Docker image digests.
- Update regression fixtures to valid encrypted-change sizes and verify write rollback, no failed-write broadcasts, unhealthy readiness while a required table is missing, and successful writes and broadcasts after repair.

### Upgrade notes

- Back up the relay volume, then rebuild both services or run `npm ci` and `npm run build` for a native installation. Preserve the existing database volume, owner keys, environment settings, and HTTP/proxy routes. No database migration, owner-key rotation, or browser package update is required.
- SQLite write failures now leave the service running and report a protocol write error. Investigate and repair the storage problem; `/health` returns 503 when required database tables are missing. Other fatal task defects retain shutdown and failure exit handling.
- Stored changes too large for a protocol message are skipped to let sync finish; this update does not recover those changes automatically.

## [2.0.1] - 2026-10-02

### Security

- Reject non-object JSON on self-service, verifier, and Agent Access routes and handle asynchronous request failures without crashing the service.
- Reject noncanonical owner IDs and normalize the owner write-lock identity to decoded bytes.
- Compare bearer token byte lengths before timing-safe comparison.

### Fixed

- Filter compacted replay timestamps from broadcasts as well as persistence, with fresh broadcasts sent under the owner write lock after a successful commit.
- Enforce the projected global live-payload total on every write, fail closed if usage is unavailable, and allow the exact per-owner quota boundary.
- Use consistent base64url owner IDs for usage metrics and owner activity.
- Preserve upstream console error levels and scopes, and keep raw diagnostic output behind `ENABLE_EVOLU_LOGGING`.
- Report database readiness from `/health`; clean up all service resources on shutdown or fatal defects.

### Changed

- Bundle Context Gateway 1.3.1 with the Agent Access request-validation and owner-ID fixes.
- Pin both Docker images to Node.js 24.21.0 LTS and keep automated Docker updates within that major.
- Update Node.js development types to 24.13.4 and the CodeQL action to 4.38.2.
- Run the regression suite in the production relay image and verify the gateway image's context upload, persistence, read, and revocation in CI.
- Update the locked Evolu core to `@evolu/common` 8.14.0 and Node adapter to 4.1.0, matching upstream relay 4.1.3.
- Port upstream WebSocket heartbeats, the 16 MiB unsent broadcast limit, and shutdown guards into the replay-protected adapter.
- Use upstream `runMain` for signal handling and fatal exit status; validate configured ports and reject truncated integer settings.
- Run the regression suite in CI and cover existing Evolu 8.7 wire requests, malformed bodies, replay broadcasts, quotas, heartbeats, readiness, and process restart/shutdown.

### Upgrade notes

- Preserve the existing database volume, owner keys, environment settings, and HTTP/proxy routes. The current GetBased browser packages do not need to change for this upgrade.
- Back up the relay volume before deployment. Global quota covers live encrypted payload bytes, not physical disk usage or tombstones; run one relay process per database.

## [2.0.0] - 2026-09-02

### Breaking changes

- Migrated the relay from Evolu 7 to Evolu 8. The reproducible install now resolves `@evolu/common` 8.9.0 and `@evolu/nodejs` 3.2.0; no Evolu source is vendored.
- Raised the runtime baseline from Node.js 22 to Node.js 24.20.0, matching the supported baseline of the current Evolu packages and the pinned Docker image.
- Bound new Agent Access context writes to an existing Evolu owner. Deployments using Context Gateway must configure a separate `CONTEXT_VERIFIER_TOKEN` and the private verifier socket or endpoint.

### Added

- Replay-protected compaction. Exact discarded timestamps are retained as tombstones so stale devices cannot refill compacted history.
- Per-owner write locking around relay writes and compaction.
- A private, single-purpose owner-proof verifier for Context Gateway.
- Owner-bound Agent Access quotas for profiles, payload bytes, and active tokens.
- Context Gateway, verifier, compaction, replay, and self-service integration coverage.

### Security

- Hardened both containers with read-only filesystems, dropped capabilities, PID and memory limits, and loopback-only published ports.
- Isolated Context Gateway from the relay database and owner write keys; verification returns only yes/no.
- Rate-limit identity now comes only from a proxy-overwritten client-IP header.

### Fixed

- Compaction now clears relay usage and timestamps atomically and is safe against concurrent writes.
- Reconnecting stale devices can no longer restore discarded pre-compaction messages.

### Upgrade notes

- Upgrade hosts to Node.js 24.20.0 or newer before running `npm ci` outside Docker.
- Back up the relay data volume before deploying a new major version.
- For Docker Compose, copy `.env.example`, set `CONTEXT_VERIFIER_TOKEN` to a random value such as the output of `openssl rand -hex 32`, then rebuild both services.

## [1.2.3] - 2026-05-11

### Added

- `/self/owner-storage` now reports `messageCount` and `lastWriteToken`, allowing clients to detect silently rejected relay pushes.

### Fixed

- Compaction clears `evolu_timestamp` and resets first/last timestamp metadata in the same transaction.
- Admin and self-service compaction now share the same implementation.

## [1.2.2] - 2026-05-04

### Security

- Bounded the rate-limit and unauthorized-log maps to 10,000 least-recently-used entries.
- Changed the default self-service bind from `0.0.0.0` to `127.0.0.1`.

### Added

- End-to-end self-service compaction coverage and both supported reverse-proxy layouts.

## [1.2.1] - 2026-05-04

- Added per-IP rate limiting and unauthorized-log coalescing for public `/self/*` routes.

## [1.2.0] - 2026-05-04

- Added HMAC-authenticated, owner-scoped compaction and storage endpoints.

## [1.1.1] - 2026-05-02

- Hardened Context Gateway input validation and closed a prototype-pollution finding.

[2.0.2]: https://github.com/elkimek/getbased-relay/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/elkimek/getbased-relay/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/elkimek/getbased-relay/compare/v1.2.3...v2.0.0
[1.2.3]: https://github.com/elkimek/getbased-relay/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/elkimek/getbased-relay/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/elkimek/getbased-relay/releases/tag/v1.2.1
[1.2.0]: https://github.com/elkimek/getbased-relay/releases/tag/v1.2.0
[1.1.1]: https://github.com/elkimek/getbased-relay/releases/tag/v1.1.1
