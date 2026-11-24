#!/usr/bin/env node
/**
 * Deploy to Cloudflare (run after `vite build`; `pnpm run deploy` does both).
 *
 *   1. apply D1 migrations, so new code never runs against an old schema
 *      (skipped on a first install: the database does not exist until step 2 creates it)
 *   2. wrangler deploy — uploads the Worker + assets; creates the D1 database if it is missing
 *   3. apply D1 migrations again — a no-op unless step 1 was skipped
 *
 * Uses <repo>/wrangler.personal.jsonc when it exists (see scripts/wrangler.mjs).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWrangler, wranglerConfigPath } from './wrangler.mjs';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const config = wranglerConfigPath();

function wrangler(args, { capture = false } = {}) {
  // Only stderr is captured (to spot "database not found"): stdout stays live for Wrangler's prompts.
  const r = runWrangler([...args, '--config', config], capture ? ['inherit', 'inherit', 'pipe'] : 'inherit');
  if (capture) process.stderr.write(r.stderr ?? '');
  return { ok: r.status === 0, output: r.stderr ?? '' };
}

const migrate = (opts) => wrangler(['d1', 'migrations', 'apply', 'DB', '--remote'], opts);

const first = migrate({ capture: true });
const missing = !first.ok && /Couldn't find (a|an auto-provisioned) D1 DB/.test(first.output);
if (!first.ok && !missing) process.exit(1);
if (missing) console.log('\nNo database yet — this looks like a first install. Deploying creates it; migrations run right after.\n');

// The Vite build wrote .wrangler/deploy/config.json pointing at the built Worker's config; Wrangler
// only follows it next to the source config, so pass the built config explicitly.
const redirect = path.join(APP_DIR, '.wrangler/deploy/config.json');
if (!existsSync(redirect)) {
  console.error('No build output found — run `vite build` first (`pnpm run deploy` does both).');
  process.exit(1);
}
const built = path.resolve(path.dirname(redirect), JSON.parse(readFileSync(redirect, 'utf8')).configPath);
const deploy = runWrangler(['deploy', '--config', built]);
if (deploy.status !== 0) process.exit(deploy.status ?? 1);

if (!migrate().ok) process.exit(1);
