# hermes

A self-hosted training platform for one self-coached, multi-sport athlete. Plan on a calendar, send
structured workouts to your Garmin, pull completed activities back, read your progress at a glance —
and let an AI agent coach you over MCP. Runs on your own Cloudflare account (Workers + D1).

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/galElmalah/hermes)

- **Calendar** — infinite month view with a weekly summary column (done vs planned, load,
  fitness/fatigue/form, week-over-week change), week, day and agenda views, drag and drop, inline
  quick-add (`run 45m easy`, `bike 4x8m 95-100% @key`), copy week with progression, undo everywhere.
- **Workouts** — a visual builder and a fast text syntax kept in sync, for cycling, running,
  swimming, rowing and strength; key-session flag, intensity, notes; a template library; one click
  to send to your watch.
- **Activities** — synced from Garmin (or FIT upload / manual entry): per-sport metrics, route,
  synchronized power / heart-rate / pace / cadence / elevation charts with range selection, laps,
  time in zones, peaks, plan vs actual, RPE, feel and notes.
- **Trends** — Load, Fitness, Fatigue and Form with a projection from your plan, weekly volume by
  sport, week-over-week progression, intensity distribution, power and pace curves, wellness,
  body weight with a smoothed trend and goal, a weekly review page and a season planner.
- Quiet by design: soft near-black or light, one rationed accent (calm blue by default; green and rose in
  Settings → Appearance), no clutter. Pages instead of modals. Everything animates. The rules are in
  `docs/DESIGN_V2.md`.
- **iOS app with widgets** (`apps/ios`): enter your server's address and passphrase; it gets its own
  revocable device token.
- **MCP server for AI agents** at `/mcp`: Claude, Claude Code, Codex or any MCP client can read your
  training and manage your plan. Clients with OAuth connect with just the URL (you approve with your
  passphrase); others use a revocable token from Settings → Agents (`docs/MCP.md`).
- Every sign-in (browser, iPhone, agent) lasts 30 days, then asks for the passphrase again.

## Repository

```
packages/core     domain types, metrics engine (load, zones, fitness model), workout logic
packages/garmin   Garmin client (Personal API + Connect), FIT parsing, mock Garmin, synthetic athlete
apps/web          the deployable: Cloudflare Worker (Hono API + D1) and the React app
apps/ios          the native iOS app and widgets (SwiftUI + WidgetKit; see apps/ios/README.md)
docs/             architecture contract and the research behind the design
```

`docs/ARCHITECTURE.md` is the map; start there.

## Run it locally

Requires Node 22+ and pnpm 10.

```bash
pnpm install
cp .dev.vars.example .dev.vars            # dev secrets; uncomment DEMO_MODE=1 for a synthetic Garmin account
cd apps/web
pnpm db:migrate:local
pnpm dev                                  # http://localhost:5173
```

On first visit you set a passphrase, then connect Garmin. In demo mode the "Use the demo Garmin
account" button connects to a built-in fake Garmin serving a realistic 12-month season, synced
through the real pipeline (list → FIT download → parse → metrics). To load the whole season plus the
athlete's plan, notes and races in one go:

```bash
node scripts/seed-demo.mjs --base http://localhost:5173      # (from apps/web) passphrase: hermes-demo
```

## Tests

```bash
pnpm -r test          # library tests + Worker tests running in workerd (Miniflare)
cd apps/web && pnpm typecheck
PW_CHROMIUM_PATH=/path/to/chromium pnpm e2e   # Playwright smoke suite against a seeded dev server
```

Worker tests run inside the Workers runtime with a real local D1; Garmin is never mocked at the
network layer — the client takes an injected `fetch`, and tests inject the fake Garmin.

## Deploy your own

Hermes is one Worker with static assets, one D1 database and a cron trigger (Garmin sync every 30
minutes). The Workers Paid plan ($5/month) is the supported target: parsing a multi-hour FIT file
needs more CPU time than the free plan allows.

### One click

Press **Deploy to Cloudflare** above. Cloudflare copies this repository to your GitHub account,
creates the D1 database, asks for the two secrets and deploys; every push to your copy redeploys.
Generate each secret with `openssl rand -base64 32`:

| Secret | What it does |
|---|---|
| `SESSION_SECRET` | Signs session cookies. Changing it signs everyone out. |
| `ENCRYPTION_KEY` | Encrypts your Garmin credentials at rest. Keep it — changing it means reconnecting Garmin. |

Open the Worker's URL (`https://hermes.<your-subdomain>.workers.dev`), set your passphrase and connect Garmin.

### From the command line

```bash
pnpm install
npx wrangler login
npx wrangler secret put SESSION_SECRET    # openssl rand -base64 32
npx wrangler secret put ENCRYPTION_KEY    # openssl rand -base64 32
pnpm run deploy                           # build → migrate → deploy (creates the D1 database on first run)
```

`wrangler.jsonc` (repo root) is the whole infrastructure definition: Worker, assets, D1 binding and
cron. It carries no account-specific ids — Wrangler finds the database by name or creates it. If you
already have a database (or want different names), put your own copy in `wrangler.personal.jsonc`
(gitignored); the build and deploy scripts use it instead when it exists.

Keep `DEMO_MODE` at `"0"`. Put Cloudflare Access in front of the Worker if you want a second lock
on the door.

### iPhone

Install the app from TestFlight (or build it yourself, see `apps/ios/README.md`), then enter your
Worker's address and passphrase on the first screen.

## Connecting your Garmin

Hermes uses two credentials (details in `packages/garmin/README.md`):

1. **Reading your data** — a Garmin *Personal API* key, created in Garmin Connect under
   Settings → Personal API Token. Official, read-only, yours.
2. **Sending workouts to the watch** — optional. Garmin's Personal API cannot write, so this uses
   the same private API the Garmin apps use, with a token file you generate once on your own
   computer and paste into Settings → Garmin. It is unofficial and may break if Garmin changes it;
   everything else keeps working without it.

Without Garmin at all you can still upload FIT files or log sessions by hand.

## Status and honest limits

- The Garmin integration is built from library source code and recorded fixtures and is tested
  against the fake Garmin. It has not yet been exercised against a live Garmin account — expect to
  shake out details on first connection (the checklist is at the end of `packages/garmin/README.md`).
- Rowing, hiking and skiing have no native Garmin workout type; they are sent as cardio with the
  targets in the step notes.
- Single user by design: no coach accounts, sharing or social features.

## Contributing, security, license

See `CONTRIBUTING.md` and `SECURITY.md`. Hermes is MIT-licensed (`LICENSE`). It is not affiliated
with Garmin; the optional workout push uses an unofficial Garmin API and may break without notice.
