-- Every sign-in lasts 30 days (SIGN_IN_LIFETIME_SEC in worker/middleware/auth.ts): device tokens
-- (iOS app, pasted MCP tokens, OAuth access tokens) get an absolute expiry, checked on every request.
-- Rows that exist when this runs get 30 days from now, so nobody is signed out by the migration.
-- A NULL expiry is treated as expired by the code.
ALTER TABLE devices ADD COLUMN expires_at TEXT;
UPDATE devices SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+30 days');

-- OAuth 2.1 authorization codes for the MCP endpoint (docs/MCP.md → OAuth). Only the SHA-256 hash
-- of a code is stored. A code lives 5 minutes and is single use: the token exchange stamps
-- `used_at`; a second exchange of the same code revokes the device it produced (`device_id`).
-- OAuth clients themselves are not stored: a registered client_id is HMAC-signed and carries its
-- name and redirect URIs. Changing the passphrase deletes every row.
CREATE TABLE oauth_codes (
  code_hash      TEXT PRIMARY KEY,        -- base64url SHA-256 of the code
  client_id      TEXT NOT NULL,
  client_name    TEXT NOT NULL,           -- becomes the device name
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,           -- PKCE S256
  resource       TEXT,                    -- RFC 8707 resource from the authorization request
  epoch          INTEGER NOT NULL,        -- auth.session_epoch at approval
  approved_at    TEXT NOT NULL,           -- passphrase entry; the access token expires 30 days later
  expires_at     TEXT NOT NULL,
  used_at        TEXT,
  device_id      TEXT                     -- the device (access token) issued for this code
);
