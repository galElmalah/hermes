# Security

Hermes holds personal health data and Garmin credentials, so security reports are very welcome.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting instead: the repository's
**Security** tab → **Report a vulnerability**. You will get a reply within a week.

## How Hermes protects your instance

- One passphrase per instance; sign-in attempts are throttled. Every session, device and agent token
  expires after 30 days and can be revoked in Settings → Devices (iPhone) or Settings → Agents.
- Device and agent tokens are stored only as SHA-256 hashes; Garmin credentials are encrypted with
  AES-GCM under your `ENCRYPTION_KEY`.
- MCP clients connect through OAuth 2.1 with PKCE, approved with your passphrase.

## Running your own

- Generate `SESSION_SECRET` and `ENCRYPTION_KEY` with `openssl rand -base64 32` and never commit them.
- Keep `DEMO_MODE` at `"0"` in production.
- Consider Cloudflare Access in front of the Worker for a second factor.
