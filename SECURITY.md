# SECURITY

## Reporting a vulnerability

Report vulnerabilities privately at <https://github.com/whoisjayd/tallymark/security/advisories/new>. Please do not open a public issue.

Expect an acknowledgement within a few days. Reports about privacy regressions (anything that stores or leaks an IP address, a raw User-Agent, or an identifier that survives the UTC day) are treated as security issues.

Only the latest released version is supported.

## Threat model

**What Tallymark does protect**

- The read API is off without `apiKey`, and keys are compared in constant time.
- `/collect` enforces a streamed 8 KB body limit, JSON validation, rate limiting, bot filtering, referrer-spam filtering, origin allow-lists, strict origin mode, and IP exclusion.
- All SQL is parameterised. CSV export neutralises spreadsheet formula injection. Imported backups are validated line by line. Webhooks are signed with HMAC-SHA256.
- Errors never leak internals to callers.
- No IP address, raw User-Agent, cookie or full query string is stored.

**What it does not protect**

- **Fake events.** The ingest endpoint is public, as in every analytics tool. A non-browser client can send any headers. The mitigations raise the cost of forging data; they cannot remove it.
- **Shared rate limits.** The built-in limiter is per process. Use your platform's rate limiting for hard limits.
- **Data at rest.** Encrypting the database is the database's job.
- **A leaked `secret`.** Anyone with it who can guess an IP and a User-Agent could recompute a visitor's hash for that day. Keep it private; changing it invalidates every visitor id.

## Deployment checklist

- [ ] `secret` and `apiKey` are long random values (`openssl rand -hex 32`) kept in a secret store, not in git, and never in client-side code.
- [ ] `trustProxy` is on only behind Cloudflare, Vercel, or a proxy you control that overwrites client-supplied IP headers. Otherwise it is off.
- [ ] TLS is terminated in front (Caddy, nginx, your platform).
- [ ] `allowedHosts` and `strictOrigin` are set to your own sites.
- [ ] `onError` is wired to your logger or alerting.
- [ ] `retentionDays` is set and `prune()` runs on a schedule.
- [ ] Backups exist (`mirrorStore`, or a scheduled `/api/export.ndjson`).
- [ ] No personal data goes into event names or properties.
