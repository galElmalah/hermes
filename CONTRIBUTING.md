# Contributing to Hermes

Thanks for helping. Hermes is a single-user, self-hosted app: changes should keep it simple to run on
one Cloudflare account and never require a third-party service beyond Cloudflare and (optionally) Garmin.

## Getting set up

```bash
pnpm install
cp .dev.vars.example .dev.vars     # uncomment DEMO_MODE=1 for the synthetic Garmin athlete
cd apps/web && pnpm db:migrate:local && pnpm dev
```

`docs/ARCHITECTURE.md` is the map of the code; `docs/DESIGN_V2.md` holds the UI rules. iOS: see
`apps/ios/README.md` (put your signing identity in the gitignored `apps/ios/Config/Local.xcconfig`).

## Before you open a pull request

- `pnpm typecheck` and `pnpm test` pass (the Worker tests run in workerd with a real local D1).
- iOS changes: `cd apps/ios/CadenceKit && swift test`, and the app builds in Xcode.
- New behaviour comes with tests. Database changes are a new numbered file in
  `apps/web/migrations/` — never edit an applied migration.
- Keep secrets, real Garmin data, personal server addresses and account ids out of commits; use
  the demo athlete and `*.example` hosts in tests and docs.

## Scope

Welcome: bug fixes, sports and metrics, Garmin robustness, MCP tools, accessibility, the iOS app.
Out of scope: multi-user accounts, coach/social features, hosted services.
