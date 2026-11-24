# Coaching with an AI agent

Hermes has a built-in MCP server, so an AI agent (Claude, Claude Code, Codex or any other MCP
client) can read your training and change your plan for you. This page covers using it. The
protocol, auth details and full tool reference are in [`MCP.md`](MCP.md).

## 1. Connect

Your endpoint is your Worker's address plus `/mcp`, e.g. `https://hermes.yourname.workers.dev/mcp`.
Settings → Agents shows it with a copy button.

**Claude (web, desktop, mobile):** Settings → Connectors → *Add custom connector* → paste the
endpoint → *Connect*. A Hermes page opens; enter your passphrase and choose **Allow access**.

**Claude Code:**

```bash
claude mcp add --transport http --scope user hermes https://hermes.yourname.workers.dev/mcp
```

Then run `/mcp` in a session, pick *hermes* → *Authenticate*, and approve in the browser.

**Codex:**

```bash
codex mcp add hermes --url https://hermes.yourname.workers.dev/mcp
codex mcp login hermes
```

**Anything else (no OAuth support):** in Settings → Agents → *Connect an agent*, name the agent,
confirm with your passphrase and choose *Create agent token*. The token (`cad_…`) is shown once,
along with ready-to-paste setup snippets. Send it as `Authorization: Bearer cad_…`.

Each connection lasts 30 days, then the agent asks you to approve it again. Every connected agent
is listed in **Settings → Agents** with its token fingerprint, when it was last used and when it
expires. **Revoke** cuts it off immediately. Changing your passphrase revokes all of them.

## 2. Ask

The agent reads your profile, zones, races and current fitness/fatigue/form before it does
anything else, so you can just talk to it. Some prompts that work well:

**Looking back**
- "How did last week go compared to the plan?"
- "Look at my load over the last 3 weeks. Am I ramping too fast?"
- "Analyse yesterday's interval run. Did I hit the paces?"
- "How have my HRV and sleep looked this month?"

**Planning**
- "Plan the next two weeks: one or two quality sessions a week, a long run on Sunday, the rest easy.
  Build gradually."
- "I have a half marathon on 12 April. Build me a block towards it and add the race to the calendar."
- "Make Thursday's session 4×8 min at threshold with 2 min jog recoveries."
- "Copy this week's structure to next week, ~10% more volume."

**Adjusting**
- "I slept badly. Swap today's workout for something easy."
- "I'm travelling Wednesday to Friday. Move things around."
- "Skip today, I'm sick." (skipped sessions count as excused, not missed)
- "My threshold pace is about 5:30/km now. Update it."

**Body weight**
- "Log 83.6 kg for today."
- "Set a goal of 78 kg by June. Is that realistic?"
- "How is my weight trending against the goal?"

**Garmin**
- "Sync now and tell me what came in."
- "Send tomorrow's workout to my watch."

## 3. Good to know

- **Changes are live.** What the agent creates or moves shows up in your calendar right away and,
  if workout push is set up, on your watch. Ask it to "propose first, then wait for my OK" if you
  want to review changes.
- The agent prefers *skip* over *delete* for sessions you didn't do, so your compliance stays honest.
- Describe workouts in plain words ("15 min warm-up, 5×3 min at 10k pace with 90 s jogs, cool down").
  The agent writes them as structured steps, so they go to your watch with targets from your zones.
- All values are metric internally. The app shows your own units.
- Give each agent its own connection and revoke the ones you stop using. A token is full access to
  your Hermes, including the JSON API.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `401` / "Missing bearer token" | Not connected yet, or the 30 days ran out: authenticate again (`/mcp` in Claude Code, `codex mcp login hermes`, or reconnect the connector) |
| OAuth page says the passphrase is wrong, then locks | Five wrong attempts trigger a growing lockout, shared with the web login. Wait, then retry |
| Agent connected but sees no activities | Garmin isn't connected or hasn't synced yet. Check Settings → Garmin, or ask the agent to `sync_now` |
| "Send to watch" fails | Pushing needs the optional Garmin token file (see the README, *Connecting your Garmin*). Reading works without it |
| Agent disappeared from the list | It was revoked, it expired, or the passphrase changed. Connect it again |
