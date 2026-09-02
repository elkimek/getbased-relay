# Changelog

Notable changes to getbased-relay are documented here. The project follows Semantic Versioning.

## [2.1.0] - 2026-09-02

### Added

- Added authenticated, owner-isolated Agent Access proposal queue routes that store only strict opaque ciphertext envelopes for browser review.

### Security

- Added owner/token-bound acknowledgement receipts so consumed proposals cannot be replayed into the live queue.
- Enforced a per-token cap across pending and acknowledged proposal IDs, preventing queue/acknowledge cycling from exhausting shared owner storage while retaining replay tombstones.

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

[2.0.0]: https://github.com/elkimek/getbased-relay/compare/v1.2.3...v2.0.0
[1.2.3]: https://github.com/elkimek/getbased-relay/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/elkimek/getbased-relay/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/elkimek/getbased-relay/releases/tag/v1.2.1
[1.2.0]: https://github.com/elkimek/getbased-relay/releases/tag/v1.2.0
[1.1.1]: https://github.com/elkimek/getbased-relay/releases/tag/v1.1.1
