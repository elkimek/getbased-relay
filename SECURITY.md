# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it privately via [GitHub Security Advisories](https://github.com/elkimek/getbased-relay/security/advisories/new).

Do **not** open a public issue for security vulnerabilities.

I'll acknowledge receipt within 48 hours and aim to release a fix within 7 days for critical issues.

## Scope

- Relay WebSocket server and CRDT sync protocol
- Admin HTTP server (health/metrics endpoints)
- Authentication (ADMIN_TOKEN bearer auth)
- SQLite database access and quota management
- Docker container security

## Architecture

The relay stores encrypted CRDT operations in SQLite. It does not decrypt or inspect user data — it only forwards opaque binary blobs between authenticated peers. The admin server binds to localhost only and requires a bearer token for sensitive endpoints.
