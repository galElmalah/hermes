#!/usr/bin/env node
/**
 * One place that decides which Wrangler config the web app uses.
 *
 *   <repo>/wrangler.personal.jsonc  — your own deployment (gitignored), used when it exists
 *   <repo>/wrangler.jsonc           — the shared config (no account-specific ids)
 *
 * Import `wranglerConfigPath()` (vite.config.ts), or run `node scripts/wrangler.mjs <wrangler args>`
 * to call Wrangler with `--config` set (package.json scripts).
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** The workspace's own Wrangler CLI (no global install or PATH needed). */
export function wranglerBin() {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve('wrangler/package.json');
  const bin = require(pkgPath).bin;
  return path.join(path.dirname(pkgPath), typeof bin === 'string' ? bin : bin.wrangler);
}

/** Run Wrangler synchronously with this Node binary. */
export function runWrangler(args, stdio = 'inherit') {
  return spawnSync(process.execPath, [wranglerBin(), ...args], { stdio, encoding: 'utf8' });
}

/** Local dev state (D1, KV…) shared by `vite dev` and local Wrangler commands. */
export const LOCAL_STATE_DIR = path.join(ROOT, 'apps/web/.wrangler/state');

export function wranglerConfigPath() {
  const personal = path.join(ROOT, 'wrangler.personal.jsonc');
  return existsSync(personal) ? personal : path.join(ROOT, 'wrangler.jsonc');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = wranglerConfigPath();
  if (process.env.HERMES_VERBOSE) console.error(`wrangler: using ${path.relative(process.cwd(), config)}`);
  const args = process.argv.slice(2);
  // Wrangler would keep local state next to the config (repo root); keep it with the app instead.
  if (args.includes('--local') && !args.some((a) => a.startsWith('--persist-to'))) args.push('--persist-to', LOCAL_STATE_DIR);
  const r = runWrangler([...args, '--config', config]);
  if (r.error) console.error(r.error.message);
  process.exit(r.status ?? 1);
}
