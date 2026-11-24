/**
 * Device tokens for native clients and AI agents (docs/MOBILE_API.md §1, docs/MCP.md). Rows hold
 * only the SHA-256 hash of a token; revoking a device deletes its row. Every token has an absolute
 * expiry (`expires_at`, 30 days after sign-in); expired rows are invisible and pruned on insert.
 */
import type { Device, DevicePlatform } from '@cadence/core/domain';
import { all, first, run } from './sql';

interface DeviceRow {
  id: string;
  name: string;
  platform: string;
  token_hash: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  via_oauth?: number | null;
}

const toDevice = (r: DeviceRow): Device => ({
  id: r.id,
  name: r.name,
  platform: r.platform === 'ios' || r.platform === 'agent' ? r.platform : 'other',
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at ?? null,
  expiresAt: r.expires_at ?? r.created_at,
  fingerprint: r.token_hash.slice(0, 8),
  connectedVia: r.via_oauth ? 'oauth' : 'passphrase',
});

export interface NewDevice {
  id: string;
  name: string;
  platform: DevicePlatform;
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
}

/** Statement inserting one device (batched with the OAuth code update). */
export const insertDeviceStmt = (db: D1Database, d: NewDevice): D1PreparedStatement =>
  db
    .prepare('INSERT INTO devices (id, name, platform, token_hash, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, NULL, ?)')
    .bind(d.id, d.name, d.platform, d.tokenHash, d.createdAt, d.expiresAt);

/** Statement deleting expired devices (batched before every insert so the table stays small). */
export const pruneExpiredDevicesStmt = (db: D1Database, nowIso: string): D1PreparedStatement =>
  db.prepare('DELETE FROM devices WHERE expires_at IS NULL OR expires_at <= ?').bind(nowIso);

/** Unexpired devices, newest first. */
export async function listDevices(db: D1Database, nowIso: string): Promise<Device[]> {
  const rows = await all<DeviceRow>(
    db,
    `SELECT d.*, EXISTS (SELECT 1 FROM oauth_codes o WHERE o.device_id = d.id) AS via_oauth
     FROM devices d WHERE d.expires_at > ? ORDER BY d.created_at DESC, d.id DESC`,
    nowIso,
  );
  return rows.map(toDevice);
}

export interface DeviceAuthRow {
  id: string;
  tokenHash: string;
  lastUsedAt: string | null;
  /** epoch ms; NaN when the row has no expiry (treated as expired) */
  expiresAt: number;
}

/** The row for a token hash, expired or not (the caller checks `expiresAt`). */
export async function findDeviceByHash(db: D1Database, tokenHash: string): Promise<DeviceAuthRow | null> {
  const r = await first<Pick<DeviceRow, 'id' | 'token_hash' | 'last_used_at' | 'expires_at'>>(
    db,
    'SELECT id, token_hash, last_used_at, expires_at FROM devices WHERE token_hash = ?',
    tokenHash,
  );
  return r ? { id: r.id, tokenHash: r.token_hash, lastUsedAt: r.last_used_at ?? null, expiresAt: r.expires_at ? Date.parse(r.expires_at) : NaN } : null;
}

/** True when a row was deleted. */
export async function deleteDevice(db: D1Database, id: string): Promise<boolean> {
  const res = await run(db, 'DELETE FROM devices WHERE id = ?', id);
  return (res.meta.changes ?? 0) > 0;
}

/** Statement deleting every device (batched with the passphrase change). */
export const deleteAllDevicesStmt = (db: D1Database): D1PreparedStatement => db.prepare('DELETE FROM devices');

/** Records use, unless the stored value is already newer than `staleBeforeIso` (another isolate wrote it). */
export async function touchDevice(db: D1Database, id: string, nowIso: string, staleBeforeIso: string): Promise<void> {
  await run(db, 'UPDATE devices SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)', nowIso, id, staleBeforeIso);
}
