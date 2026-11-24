# MCP server (AI agents)

Hermes exposes a remote [Model Context Protocol](https://modelcontextprotocol.io) server so AI
agents (Claude Code, Claude desktop, Codex, any MCP client) can read the athlete's training and
manage the plan. It runs inside the same Worker as the app; there are no extra bindings or services.

| | |
|---|---|
| Endpoint | `https://<your-worker>/mcp` (e.g. `https://hermes.yourname.workers.dev/mcp`) |
| Transport | Streamable HTTP, stateless: `POST` only (`GET`/`DELETE` → `405`), no `Mcp-Session-Id` |
| Protocol | MCP **2026-07-28**, plus 2025-era clients (`initialize` handshake: 2025-11-25, 2025-06-18, 2025-03-26) |
| Auth | `Authorization: Bearer cad_…`, a revocable device token valid 30 days, obtained through **OAuth 2.1** (approve with your passphrase) or pasted from Settings → Agents |
| Code | `apps/web/worker/mcp/` (official SDK `@modelcontextprotocol/server`, loaded lazily on the first `/mcp` request) |

## Connecting

Two ways, both ending in the same kind of credential: a device token (`cad_…`) that lasts **30 days
from the moment you typed your passphrase**, shows up in Settings → Agents,
and can be revoked there at once (within 30 s on other Worker isolates). Changing the passphrase
revokes every token. After 30 days the client gets a `401` and has to be approved again — there is no
refresh token and no sliding renewal, by design.

### With OAuth (just the URL)

Clients that support MCP authorization (Claude on the web/desktop/mobile as a custom connector,
Claude Code, Codex, MCP Inspector …) only need the endpoint URL. On first use they get a `401`,
discover Hermes' authorization server, register themselves and open a Hermes page in the browser:
**Connect "<client>" to Hermes**, showing the client's name and the address it returns to. Enter your
passphrase and choose **Allow access**. The client is connected for 30 days and appears in Settings →
Agents under its own name.

- **Claude (claude.ai / desktop)**: Settings → Connectors → Add custom connector → URL
  `https://<your-worker>/mcp` → Connect.
- **Claude Code**: `claude mcp add --transport http hermes https://<your-worker>/mcp`, then run
  `/mcp` in a session and pick "Authenticate" for hermes.
- **Codex**: `codex mcp add hermes --url https://<your-worker>/mcp`, then `codex mcp login hermes`.

The consent page is rate-limited together with the web login (5 wrong passphrases → growing lockout,
shared with `POST /api/auth/login` and `POST /api/auth/devices`).

### With a pasted token

Settings → Agents → **Connect an agent**: give the agent a name (e.g. "Claude Code"), confirm
with your passphrase, then **Create agent token**. The token is shown **once**, with copy buttons
and ready-to-paste setup snippets for this server's address. The agent then appears in the Agents
table with a short token fingerprint, how it connected, a "Last used" time and when it expires.

Under the hood this is `POST /api/auth/devices { passphrase, name, platform: "agent" }`
(`docs/MOBILE_API.md` §1), so you can also mint one from a script.

A device token (pasted or from OAuth) is a full-access credential for this single-user app: the same
token also works against the JSON API (`/api/*`). Give each agent its own and revoke the ones you stop
using.

## Client setup with a pasted token

**Claude Code** (from its MCP docs: `claude mcp add --transport http <name> <url> --header …`):

```bash
claude mcp add --transport http hermes https://hermes.yourname.workers.dev/mcp \
  --header "Authorization: Bearer cad_…"
# --scope local (default, this project only) | project (.mcp.json) | user (all projects)
claude mcp list                  # shows ✔ Connected
claude mcp remove hermes         # undo
```

To keep the token out of a shared `.mcp.json`, reference an environment variable instead:

```json
{
  "mcpServers": {
    "hermes": {
      "type": "http",
      "url": "https://hermes.yourname.workers.dev/mcp",
      "headers": { "Authorization": "Bearer ${HERMES_MCP_TOKEN}" }
    }
  }
}
```

**Other clients**: any MCP client that supports remote Streamable HTTP servers with a custom
header. The JSON above is the common `mcpServers` shape (`type: "http"`, `url`, `headers`). Clients
that only offer OAuth use the flow above.

**MCP Inspector** (handy for debugging):

```bash
npx @modelcontextprotocol/inspector --cli --transport http --server-url https://…/mcp \
  --header "Authorization: Bearer cad_…" --method tools/list
npx @modelcontextprotocol/inspector --cli --transport http --server-url https://…/mcp \
  --header "Authorization: Bearer cad_…" --method tools/call --tool-name get_today
# add --protocol-era modern to use 2026-07-28 instead of the initialize handshake
```

## Errors

| Situation | Response |
|---|---|
| No `Authorization: Bearer …` header (cookies are not accepted) | `401`, `WWW-Authenticate: Bearer realm="hermes", resource_metadata="https://…/.well-known/oauth-protected-resource/mcp"` |
| Unknown / revoked / expired / malformed token | `401`, same challenge plus `error="invalid_token", error_description=…` (OAuth clients re-authorize) |
| `Origin` header from another host (DNS-rebinding defence) | `403` |
| Protocol problems (unsupported version, bad headers, unknown method) | handled by the SDK per spec (`400` / `404` with JSON-RPC errors) |
| Invalid tool arguments (wrong date format, unknown sport, range too long…) | tool result with `isError: true` and a message naming the field |
| API errors inside a tool (not found, Garmin not connected…) | tool result with `isError: true`, text `code: message` |

## Conventions for tool data

- Dates are `YYYY-MM-DD` **in the athlete's time zone** (`get_athlete_context.profile.timezone`);
  "today" comes from there. Times are local `HH:MM`.
- Always metric, unit in the field name: `…Sec`, `…M`, `…Mps`, `…W`, `…Bpm`, `…Kg`; paces also as
  strings (`"4:05/km"`, `"1:45/100m"`, `"1:52/500m"`). `unitsPreference` is informational.
- Outputs are compact JSON; absent values are omitted. Per-second streams are only returned by
  `get_activity` on request, downsampled to ≤ 1000 points.
- Planned workouts use the app's workout text syntax (`packages/core/src/workout/text.ts`); the
  `create_workout` description carries a summary and examples, e.g.
  `"- wu 15m 55-65%\n3x\n  - 10m 95-100%\n  - r 5m 55%\n- cd 10m 50%"`.
- Every tool goes through the JSON API in-process with the caller's token, so it behaves exactly
  like the web app (validation, compliance, re-pairing, Garmin re-push, background recomputes).

## Tools

Annotations: **R** = `readOnlyHint`; **D** = `destructiveHint` (overwrites or deletes); **W** =
writes but not destructive; **O** = `openWorldHint` (talks to Garmin).

| Tool | | What it does |
|---|---|---|
| `get_athlete_context` | R | Start here: profile, units, timezone, today, thresholds + HR/power/pace zones per sport, upcoming events, fitness/fatigue/form, this week, Garmin status and last sync |
| `get_calendar` | R | `from`/`to` (≤ 92 days): per-day planned workouts (with compliance), activities, notes, markers; events, phases, ISO-week summaries |
| `get_today` | R | Today's workouts and activities, readiness (heuristic), wellness, form, week totals, next event / A-race, day note |
| `get_workout` | R | One planned workout incl. steps as workout text (raw JSON on request) and execution analysis when paired |
| `create_workout` | W | From workout `text`, raw `structure`, a `templateId`, or an unstructured duration/distance |
| `update_workout` | D | Patch fields / replace steps; `null` clears optional fields; `scope: following` for series |
| `move_workout` | W | New date (and time); `scope: following` shifts the rest of the series |
| `delete_workout` | D | Permanent delete (also removes it from Garmin) |
| `skip_workout` | W | Skip with a reason (counts as excused) or `unskip` |
| `list_templates` | R | Library templates (sport / intensity / text filter) with steps as text |
| `list_activities` | R | Filtered, newest first, cursor-paginated, with totals |
| `get_activity` | R | Summary, plan vs actual (planned workout, compliance, step-by-step `execution` when the API provides it), laps, zones, optional peaks and downsampled streams |
| `get_fitness_trend` | R | Daily load, fitness, fatigue, form, form %, zone, ramp; projection from the plan; weekly sampling for long ranges |
| `get_weekly_summary` | R | Per ISO week: planned vs done time/load/distance, per sport, compliance, intensity split, form, WoW change |
| `get_wellness` | R | HRV + baseline, resting HR, sleep, body battery, weight, check-in, readiness (≤ 120 days) |
| `get_weight` | R | Weight readings + smoothed trend, 7/28-day change, kg/week rate, goal progress (≤ 730 days) |
| `log_weight` | W | Log (or clear) a day's weight in kg; keeps the weight threshold in step (≥ 0.5 kg moves) |
| `set_weight_goal` | W | Target kg + optional date (progress from the current trend), or `clear` |
| `get_thresholds` | R | Current thresholds + zones per sport and the dated history |
| `set_threshold` | W | FTP, run threshold (pace `"m:ss"`/km or m/s), swim CSS, row, LTHR, HR max/rest, weight; dated |
| `list_events` / `create_event` / `update_event` / `delete_event` | R / W / D / D | Races and milestones (priority A/B/C, distance m, goal, location) |
| `set_day_note` | D | Replace a day's note (`""` deletes it) |
| `sync_now` | W, O | Run a Garmin sync now (activities, wellness, thresholds, push pending workouts) |
| `push_workout_to_watch` | W, O | Send one workout to Garmin; clear error when Garmin is not connected or only read access (Personal API key) is configured |

## OAuth details

Hermes is its own authorization server; everything lives in `apps/web/worker/oauth/` (no extra
bindings, D1 only). Spec: MCP authorization (draft as of 2026-11), OAuth 2.1.

| | |
|---|---|
| Protected resource metadata (RFC 9728) | `GET /.well-known/oauth-protected-resource/mcp` and `GET /.well-known/oauth-protected-resource` → `{ resource: "<origin>/mcp", authorization_servers: ["<origin>"], bearer_methods_supported: ["header"] }`; no scopes |
| Authorization server metadata (RFC 8414) | `GET /.well-known/oauth-authorization-server` (issuer = origin). Other `/.well-known/oauth-*` paths → JSON `404`; `openid-configuration` is not served |
| Registration (RFC 7591) | `POST /oauth/register` — open. Public clients (`token_endpoint_auth_method: "none"`, the default); `client_secret_post` / `client_secret_basic` also accepted. `redirect_uris`: 1–10, `https`, `http` only for loopback (`localhost`, `127.0.0.1`, `[::1]`), or an app's private-use scheme; no fragments. Nothing is stored: the `client_id` is HMAC-signed (key derived from `SESSION_SECRET`) and carries the name and redirect URIs; a confidential client's secret is an HMAC of its `client_id`. Rotating `SESSION_SECRET` invalidates registrations, so clients have to be re-added (they also lose their sessions). Client ID Metadata Documents are not supported (not advertised); clients fall back to registration |
| Authorize | `GET /oauth/authorize` — `response_type=code`, PKCE `code_challenge` + `code_challenge_method=S256` mandatory, `redirect_uri` required and matched exactly against the registration (loopback `http` may use any port, RFC 8252 §7.3), `state` returned verbatim, `resource` (RFC 8707) must be `<origin>/mcp` (or the bare origin). An unknown client or redirect URI shows an error page and never redirects; other problems redirect back with `error`. `scope` is ignored |
| Consent | Server-rendered page; approving needs the passphrase (same verification and throttle as login; a session cookie is not enough). The form carries a signed 10-minute copy of the validated request, a foreign `Origin` is refused, and the page cannot be framed. **Cancel** → `error=access_denied`. Responses carry `iss` (RFC 9207) |
| Code | 32 random bytes, 5-minute lifetime, single use; only its SHA-256 is stored (`oauth_codes`). Exchanging a code twice revokes the token issued for it |
| Token | `POST /oauth/token` (form or JSON), `grant_type=authorization_code` only, `code_verifier` + `redirect_uri` + `client_id` required → `{ access_token: "cad_…", token_type: "Bearer", expires_in }`, `Cache-Control: no-store`. The token is a device row (`platform: "agent"`, name = client name) whose expiry is 30 days after the passphrase entry |
| No refresh tokens | The access token already lasts the full 30 days one passphrase entry allows, so a refresh token could not extend anything. Clients handle a missing `refresh_token` by re-running the flow on the `401` after expiry |
| Revocation | Settings → Agents → Revoke (or `DELETE /api/auth/devices/:id`). A passphrase change deletes every device and every pending code |
| CORS | `Access-Control-Allow-Origin: *` (no credentials) on the metadata, registration and token endpoints for browser-based clients; never on `/api` or the consent page |

## Limits and notes

- Stateless: each POST is served by a fresh server instance; nothing is kept between requests.
  `subscriptions/listen` (2026-07-28) is accepted but never emits change events (the tool list is
  static); the stream only carries keep-alive comments until the client closes it.
- No resources or prompts, only tools. No OAuth scopes: a connected client has full access.
- Range caps: calendar 92 days, wellness 120 days, weekly summaries 52 weeks, fitness trend ~3 years,
  activity list 100 per page, streams 1000 points.
- No undo through MCP: `delete_workout` / `delete_event` are permanent (the web app's undo toast does
  not apply). Prefer `skip_workout` for sessions that were not done.
- The execution analysis (plan vs actual per step) is passed through from the API's `execution`
  field (`docs/MOBILE_API.md` §4); `worker/mcp/execution.ts` compacts it, and tools omit it when the
  API does not return one.
- The SDK chunk (≈ 600 KB unminified, ≈ 146 KB gzip) is a separate module loaded on the first
  `/mcp` request, so it does not slow the JSON API's start-up.
