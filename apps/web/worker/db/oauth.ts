/**
 * OAuth authorization codes for the MCP endpoint (worker/oauth, docs/MCP.md → OAuth). Only the
 * SHA-256 hash of a code is stored. Codes are single use: `claimOAuthCode` stamps `used_at`
 * atomically, so of two concurrent exchanges exactly one wins.
 */
import { first } from './sql';

interface OAuthCodeRow {
  code_hash: string;
  client_id: string;
  client_name: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string | null;
  epoch: number;
  approved_at: string;
  expires_at: string;
  used_at: string | null;
  device_id: string | null;
}

export interface OAuthCode {
  codeHash: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string | null;
  epoch: number;
  approvedAt: string;
  expiresAt: string;
  usedAt: string | null;
  deviceId: string | null;
}

const toCode = (r: OAuthCodeRow): OAuthCode => ({
  codeHash: r.code_hash,
  clientId: r.client_id,
  clientName: r.client_name,
  redirectUri: r.redirect_uri,
  codeChallenge: r.code_challenge,
  resource: r.resource ?? null,
  epoch: r.epoch,
  approvedAt: r.approved_at,
  expiresAt: r.expires_at,
  usedAt: r.used_at ?? null,
  deviceId: r.device_id ?? null,
});

/** Stores a fresh code and drops expired ones (codes live minutes, so the table stays tiny). */
export async function insertOAuthCode(db: D1Database, c: Omit<OAuthCode, 'usedAt' | 'deviceId'>): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM oauth_codes WHERE expires_at <= ?').bind(c.approvedAt),
    db
      .prepare(
        `INSERT INTO oauth_codes (code_hash, client_id, client_name, redirect_uri, code_challenge, resource, epoch, approved_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(c.codeHash, c.clientId, c.clientName, c.redirectUri, c.codeChallenge, c.resource, c.epoch, c.approvedAt, c.expiresAt),
  ]);
}

/** Marks an unused code as used and returns it; null when unknown or already used. */
export async function claimOAuthCode(db: D1Database, codeHash: string, nowIso: string): Promise<OAuthCode | null> {
  const r = await first<OAuthCodeRow>(db, 'UPDATE oauth_codes SET used_at = ? WHERE code_hash = ? AND used_at IS NULL RETURNING *', nowIso, codeHash);
  return r ? toCode(r) : null;
}

export async function findOAuthCode(db: D1Database, codeHash: string): Promise<OAuthCode | null> {
  const r = await first<OAuthCodeRow>(db, 'SELECT * FROM oauth_codes WHERE code_hash = ?', codeHash);
  return r ? toCode(r) : null;
}

/** Statement recording which device (access token) a code produced. */
export const linkOAuthCodeStmt = (db: D1Database, codeHash: string, deviceId: string): D1PreparedStatement =>
  db.prepare('UPDATE oauth_codes SET device_id = ? WHERE code_hash = ?').bind(deviceId, codeHash);

/** Statement deleting every code (batched with the passphrase change). */
export const deleteAllOAuthCodesStmt = (db: D1Database): D1PreparedStatement => db.prepare('DELETE FROM oauth_codes');
