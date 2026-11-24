/** MCP endpoint (docs/MCP.md): auth, protocol round-trips (both eras) and tool calls. */
import { describe, expect, it, vi } from 'vitest';
import { exports } from 'cloudflare:workers';
import { BASE, TEST_PASSPHRASE, anon } from './helpers';

vi.setConfig({ testTimeout: 60_000 });

const URL_MCP = `${BASE}/mcp`;
const LEGACY = '2025-11-25';
const MODERN = '2026-07-28';
let token = '';
let nextId = 1;

const mcpFetch = (body: unknown, headers: Record<string, string> = {}, method = 'POST') =>
  exports.default.fetch(URL_MCP, {
    method,
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  });

/** JSON-RPC message from a JSON or single-event SSE response. */
async function message(res: Response): Promise<any> {
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const data = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean);
    return JSON.parse(data.at(-1)!);
  }
  return JSON.parse(text);
}

/** A 2025-era request (stateless: every POST stands alone). */
async function rpc(method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  const res = await mcpFetch({ jsonrpc: '2.0', id: nextId++, method, params }, { authorization: `Bearer ${token}`, 'mcp-protocol-version': LEGACY, ...headers });
  expect(res.status, `${method} → ${res.status}`).toBe(200);
  return message(res);
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const m = await rpc('tools/call', { name, arguments: args });
  expect(m.error, JSON.stringify(m.error)).toBeUndefined();
  const r = m.result as { content: { type: string; text: string }[]; isError?: boolean };
  return { isError: !!r.isError, text: r.content[0]?.text ?? '', json: () => JSON.parse(r.content[0].text) };
}

async function ok(name: string, args: Record<string, unknown> = {}) {
  const r = await call(name, args);
  expect(r.isError, `${name}: ${r.text}`).toBe(false);
  return r.json();
}

describe('MCP endpoint', () => {
  it('creates an agent token through the device API', async () => {
    await anon('/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: TEST_PASSPHRASE }) });
    const res = await anon('/auth/devices', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ passphrase: TEST_PASSPHRASE, name: 'Claude Code', platform: 'agent' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json<{ token: string; device: { platform: string } }>();
    expect(body.device.platform).toBe('agent');
    token = body.token;
    const list = await anon('/auth/devices', { headers: { authorization: `Bearer ${token}` } });
    expect((await list.json<{ devices: { platform: string }[] }>()).devices[0].platform).toBe('agent');
  });

  it('rejects requests without a valid bearer token (401 + WWW-Authenticate)', async () => {
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: 't', version: '0' } } };
    const none = await mcpFetch(init);
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toMatch(/^Bearer realm="hermes"/);
    expect(none.headers.get('www-authenticate')).toContain(`resource_metadata="${BASE}/.well-known/oauth-protected-resource/mcp"`);

    const bad = await mcpFetch(init, { authorization: 'Bearer cad_' + 'x'.repeat(43) });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('www-authenticate')).toContain('error="invalid_token"');

    const malformed = await mcpFetch(init, { authorization: 'Bearer nope' });
    expect(malformed.status).toBe(401);

    // a browser session cookie is not enough
    const login = await anon('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: TEST_PASSPHRASE }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    expect((await mcpFetch(init, { cookie })).status).toBe(401);

    // OAuth discovery is served by the Worker (o-oauth.test.ts covers the flow)
    const wk = await exports.default.fetch(`${BASE}/.well-known/oauth-protected-resource`);
    expect(wk.status).toBe(200);
    expect(await wk.json()).toMatchObject({ resource: URL_MCP });
  });

  it('rejects a foreign Origin with 403', async () => {
    const res = await mcpFetch({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { authorization: `Bearer ${token}`, origin: 'https://evil.example', 'mcp-protocol-version': LEGACY });
    expect(res.status).toBe(403);
  });

  it('initializes (2025-11-25 handshake), acknowledges notifications and refuses GET', async () => {
    const m = await rpc('initialize', { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: 'vitest', version: '1' } });
    expect(m.result.protocolVersion).toBe(LEGACY);
    expect(m.result.serverInfo.name).toBe('hermes');
    expect(m.result.capabilities.tools).toBeDefined();
    expect(m.result.instructions).toContain('get_athlete_context');

    // unsupported version → the server answers with one it supports
    const old = await rpc('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'vitest', version: '1' } });
    expect(typeof old.result.protocolVersion).toBe('string');
    expect(old.result.protocolVersion).not.toBe('1999-01-01');

    const note = await mcpFetch({ jsonrpc: '2.0', method: 'notifications/initialized' }, { authorization: `Bearer ${token}`, 'mcp-protocol-version': LEGACY });
    expect(note.status).toBe(202);

    const ping = await rpc('ping');
    expect(ping.result).toEqual({});

    const get = await mcpFetch(undefined, { authorization: `Bearer ${token}` }, 'GET');
    expect(get.status).toBe(405);
  });

  it('serves 2026-07-28 traffic (server/discover, per-request _meta)', async () => {
    const meta = {
      'io.modelcontextprotocol/protocolVersion': MODERN,
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 'vitest', version: '1' },
    };
    const headers = { authorization: `Bearer ${token}`, 'mcp-protocol-version': MODERN };
    const discover = await mcpFetch({ jsonrpc: '2.0', id: nextId++, method: 'server/discover', params: { _meta: meta } }, { ...headers, 'mcp-method': 'server/discover' });
    expect(discover.status).toBe(200);
    const d = await message(discover);
    expect(d.result.supportedVersions).toContain(MODERN);
    expect(d.result.capabilities.tools).toBeDefined();

    const list = await mcpFetch({ jsonrpc: '2.0', id: nextId++, method: 'tools/list', params: { _meta: meta } }, { ...headers, 'mcp-method': 'tools/list' });
    expect(list.status).toBe(200);
    const l = await message(list);
    expect(l.result.tools.length).toBeGreaterThan(20);

    const called = await mcpFetch(
      { jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name: 'get_today', arguments: {}, _meta: meta } },
      { ...headers, 'mcp-method': 'tools/call', 'mcp-name': 'get_today' },
    );
    expect(called.status).toBe(200);
    const c = await message(called);
    expect(c.result.isError ?? false).toBe(false);
    expect(JSON.parse(c.result.content[0].text).date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('lists every tool with schemas and read-only / destructive annotations', async () => {
    const m = await rpc('tools/list');
    const tools = m.result.tools as { name: string; description: string; inputSchema: { type: string }; annotations: Record<string, boolean> }[];
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of [
      'get_athlete_context', 'get_calendar', 'get_today', 'get_workout', 'create_workout', 'update_workout', 'move_workout', 'delete_workout',
      'skip_workout', 'list_templates', 'list_activities', 'get_activity', 'get_fitness_trend', 'get_weekly_summary', 'get_wellness',
      'get_thresholds', 'set_threshold', 'list_events', 'create_event', 'update_event', 'delete_event', 'set_day_note', 'sync_now', 'push_workout_to_watch',
      'log_weight', 'get_weight', 'set_weight_goal',
    ]) {
      expect(byName.has(name), name).toBe(true);
      expect(byName.get(name)!.inputSchema.type).toBe('object');
      expect(byName.get(name)!.description.length).toBeGreaterThan(40);
    }
    expect(byName.get('get_calendar')!.annotations).toMatchObject({ readOnlyHint: true });
    expect(byName.get('delete_workout')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(byName.get('create_workout')!.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.get('sync_now')!.annotations).toMatchObject({ openWorldHint: true });
    expect(byName.get('create_workout')!.description).toContain('Nx');
  });

  it('returns the athlete context', async () => {
    await ok('set_threshold', { kind: 'ftp', value: 280, effectiveFrom: '2020-01-01' });
    await ok('set_threshold', { kind: 'run_threshold', pace: '4:00', effectiveFrom: '2020-01-01' });
    const ctx = await ok('get_athlete_context');
    expect(ctx.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(ctx.profile.timezone).toBeTruthy();
    expect(ctx.sports.bike.thresholds.ftpW).toBe(280);
    expect(ctx.sports.bike.powerZones.zones.length).toBeGreaterThan(4);
    expect(ctx.sports.run.thresholds.runThresholdPace).toBe('4:00/km');
    expect(ctx.sports.run.paceZones.zones[0].paceRange).toContain('/km');
    expect(ctx.garmin.connected).toBe(false);
  });

  it('runs a create → get → update → move → skip → delete workout cycle', async () => {
    const ctx = await ok('get_athlete_context');
    const day = ctx.today as string;
    const created = await ok('create_workout', {
      date: day,
      sport: 'bike',
      text: '- wu 15m 55-65%\n3x\n  - 10m 95-100%\n  - r 5m 55%\n- cd 10m 50%',
      isKey: true,
    });
    const w = created.created;
    expect(w.id).toMatch(/^wk_/);
    expect(w.plannedDurationSec).toBe(70 * 60);
    expect(w.plannedLoad).toBeGreaterThan(40);
    expect(w.isKey).toBe(true);
    expect(w.structureText).toContain('3x');

    const got = await ok('get_workout', { id: w.id, includeStructureJson: true });
    expect(got.structure.steps.length).toBe(3);

    const updated = await ok('update_workout', { id: w.id, title: 'Sweet spot 3×10', text: '- wu 10m 60%\n2x\n  - 12m 90%\n  - r 4m 55%\n- cd 10m 50%', description: 'Keep cadence high' });
    expect(updated.updated).toMatchObject({ title: 'Sweet spot 3×10', description: 'Keep cadence high', plannedDurationSec: 52 * 60 });

    const cleared = await ok('update_workout', { id: w.id, description: null });
    expect(cleared.updated.description).toBeUndefined();

    const tomorrow = new Date(Date.parse(day + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);
    const moved = await ok('move_workout', { id: w.id, date: tomorrow, startTime: '06:30' });
    expect(moved.moved).toMatchObject({ date: tomorrow, startTime: '06:30' });

    const cal = await ok('get_calendar', { from: day, to: tomorrow });
    expect(cal.days.find((d: { date: string }) => d.date === tomorrow).workouts[0].id).toBe(w.id);

    const skipped = await ok('skip_workout', { id: w.id, reason: 'travel' });
    expect(skipped.workout).toMatchObject({ status: 'skipped', skipReason: 'travel' });
    const unskipped = await ok('skip_workout', { id: w.id, unskip: true });
    expect(unskipped.workout.status).toBe('planned');

    const deleted = await ok('delete_workout', { id: w.id });
    expect(deleted.deleted).toEqual([{ id: w.id, date: tomorrow, title: 'Sweet spot 3×10' }]);

    const gone = await call('get_workout', { id: w.id });
    expect(gone.isError).toBe(true);
    expect(gone.text).toContain('not_found');
  });

  it('accepts the documented run, swim and strength examples', async () => {
    const day = (await ok('get_athlete_context')).today;
    const run = await ok('create_workout', { date: day, sport: 'run', text: '- wu 2km easy\n6x\n  - 800m 4:05/km\n  - r 400m easy\n- cd 10m easy' });
    expect(run.created.plannedDistanceM).toBeGreaterThan(8000);
    const swim = await ok('create_workout', { date: day, sport: 'swim', text: 'pool 25m\n- wu 400m choice\n8x\n  - 100m css on 1:50\n- cd 200m easy' });
    expect(swim.created.plannedDistanceM).toBe(1400);
    const st = await ok('create_workout', { date: day, sport: 'strength', text: 'Back squat 4x6 @80kg rpe 8 r 2m' });
    expect(st.created.structured).toBe(true);
    const plain = await ok('create_workout', { date: day, sport: 'run', title: 'Easy jog', plannedDurationSec: 2700 });
    expect(plain.created).toMatchObject({ title: 'Easy jog', plannedDurationSec: 2700, structured: false });
    for (const w of [run, swim, st, plain]) await ok('delete_workout', { id: w.created.id });
  });

  it('reports invalid input and unparseable text as tool errors', async () => {
    const bad = await call('create_workout', { date: 'tomorrow', sport: 'bike' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/date/i);

    const badSport = await call('create_workout', { date: '2026-01-01', sport: 'curling' });
    expect(badSport.isError).toBe(true);

    const unparsable = await call('create_workout', { date: '2026-01-01', sport: 'bike', text: '- banana' });
    expect(unparsable.isError).toBe(true);
    expect(unparsable.text).toContain('Could not parse');

    const both = await call('create_workout', { date: '2026-01-01', sport: 'bike', text: '- 10m 50%', templateId: 'tpl_x' });
    expect(both.isError).toBe(true);

    const range = await call('get_calendar', { from: '2026-01-01', to: '2026-12-31' });
    expect(range.isError).toBe(true);
    expect(range.text).toContain('max 92');

    const unknown = await rpc('tools/call', { name: 'drop_database', arguments: {} });
    expect(unknown.error ?? unknown.result?.isError).toBeTruthy();
  });

  it('reads activities, trends, wellness and templates', async () => {
    const day = (await ok('get_athlete_context')).today as string;
    const res = await exports.default.fetch(`${BASE}/api/activities/manual`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ localDate: day, startTime: '07:15', sport: 'run', title: 'Morning run', durationSec: 3000, distanceM: 10_000, avgHr: 150, rpe: 5 }),
    });
    expect(res.status).toBe(201);

    const list = await ok('list_activities', { from: day, to: day });
    const a = list.activities[0];
    expect(a).toMatchObject({ date: day, startTime: '07:15', sport: 'run', distanceM: 10000, avgPace: '5:00/km', avgHrBpm: 150 });
    expect(list.totals.count).toBe(1);

    const detail = await ok('get_activity', { id: a.id, peaks: true, streams: { maxPoints: 50 } });
    expect(detail).toMatchObject({ id: a.id, title: 'Morning run' });
    expect(detail.streams.unavailable).toBeTruthy();

    const fit = await ok('get_fitness_trend', {});
    expect(fit.days.length).toBeGreaterThan(90);
    const weekly = await ok('get_fitness_trend', { from: '2026-01-01', to: day > '2026-06-30' ? day : '2026-06-30' });
    expect(weekly.resolution).toMatch(/^week/);

    const weeks = await ok('get_weekly_summary', { weeks: 4 });
    expect(weeks.weeks.length).toBe(4);
    expect(weeks.weeks.at(-1).doneSec).toBeGreaterThanOrEqual(3000);

    const well = await ok('get_wellness', {});
    expect(well.days.length).toBe(14);

    const logged = await ok('log_weight', { weightKg: 84, date: day });
    expect(logged.logged).toMatchObject({ date: day, weightKg: 84 });
    expect(logged.weight).toMatchObject({ latestKg: 84, latestDate: day });
    const goal = await ok('set_weight_goal', { targetKg: 78 });
    expect(goal.weight.goal).toMatchObject({ targetKg: 78, startKg: 84 });
    const wt = await ok('get_weight', {});
    expect(wt.readings.at(-1)).toMatchObject({ date: day, weightKg: 84 });
    expect((await ok('get_athlete_context')).bodyWeight).toMatchObject({ latestKg: 84, goal: { targetKg: 78 } });
    expect((await ok('set_weight_goal', { clear: true })).cleared).toBe(true);
    expect((await call('set_weight_goal', {})).isError).toBe(true);

    const tpl = await ok('list_templates', { sport: 'bike', limit: 3 });
    expect(tpl.templates.length).toBeLessThanOrEqual(3);
    if (tpl.templates.length) {
      const scheduled = await ok('create_workout', { date: day, sport: 'bike', templateId: tpl.templates[0].id });
      expect(scheduled.created.templateId).toBe(tpl.templates[0].id);
      await ok('delete_workout', { id: scheduled.created.id });
    }

    const th = await ok('get_thresholds');
    expect(th.history.some((h: { kind: string }) => h.kind === 'ftp')).toBe(true);
  });

  it('manages events and day notes', async () => {
    const ev = await ok('create_event', { date: '2030-04-14', name: 'Spring marathon', priority: 'A', sport: 'run', distanceM: 42195, goal: 'sub 3:00' });
    expect(ev.created.id).toMatch(/^evt_/);
    const upd = await ok('update_event', { id: ev.created.id, goal: null, location: 'Rotterdam' });
    expect(upd.updated).toMatchObject({ location: 'Rotterdam', name: 'Spring marathon' });
    expect(upd.updated.goal).toBeUndefined();
    const list = await ok('list_events', {});
    expect(list.events.some((e: { id: string }) => e.id === ev.created.id)).toBe(true);
    await ok('delete_event', { id: ev.created.id });

    const note = await ok('set_day_note', { date: '2030-04-13', body: 'Carb load' });
    expect(note.note).toBe('Carb load');
    const cleared = await ok('set_day_note', { date: '2030-04-13', body: '' });
    expect(cleared.deleted).toBe(true);
  });

  it('explains Garmin preconditions', async () => {
    const day = (await ok('get_athlete_context')).today;
    const w = (await ok('create_workout', { date: day, sport: 'run', plannedDurationSec: 1800 })).created;
    const push = await call('push_workout_to_watch', { workoutId: w.id });
    expect(push.isError).toBe(true);
    expect(push.text).toContain('not connected');
    const sync = await call('sync_now');
    expect(sync.isError).toBe(true);
    expect(sync.text).toContain('garmin_not_connected');
  });

  it('stops working once the agent token is revoked', async () => {
    const devices = await (await anon('/auth/devices', { headers: { authorization: `Bearer ${token}` } })).json<{ devices: { id: string }[] }>();
    const del = await anon(`/auth/devices/${devices.devices[0].id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
    expect(del.status).toBe(204);
    const res = await mcpFetch({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { authorization: `Bearer ${token}`, 'mcp-protocol-version': LEGACY });
    expect(res.status).toBe(401);
  });
});
