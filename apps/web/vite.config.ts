import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { cloudflare } from '@cloudflare/vite-plugin';
// @ts-expect-error plain ESM helper without types
import { LOCAL_STATE_DIR, wranglerConfigPath } from './scripts/wrangler.mjs';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    cloudflare({
      // <repo>/wrangler.personal.jsonc when present, else <repo>/wrangler.jsonc
      configPath: wranglerConfigPath(),
      // E2E runs and parallel dev sessions point this at an isolated state dir.
      persistState: { path: process.env.CF_PERSIST_TO ?? LOCAL_STATE_DIR },
    }),
  ],
  // Parallel dev sessions can isolate the optimizer cache.
  cacheDir: process.env.VITE_CACHE_DIR ?? 'node_modules/.vite',
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
});
