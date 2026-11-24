/** OAuth 2.1 for the MCP endpoint (docs/MCP.md → OAuth): discovery, registration, consent, token, lifetime. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env, exports } from 'cloudflare:workers';
import { Device } from '@cadence/core/domain';
import { BASE, TEST_PASSPHRASE, anon } from './helpers';

vi.setConfig({ testTimeout: 60_000 });

const MCP = `${BASE}/mcp`;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const NEXT_PASSPHRASE = 'a different passphrase entirely';
const DAY_MS = 86400_000;

const w = (path: string, init?: RequestInit) => exports.default.fetch(`${BASE}${path}`, { redirect: 'manual', ...init });
const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const resetThrottle = () => env.DB.prepare(`DELETE FROM sync_state WHERE key = 'auth.throttle'`).run();

afterEach(() => {
  vi.useRealTimers();
});

function b64u(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...u8)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64u(crypto.getRandomValues(new Uint8Array(32)));
  return { verifier, challenge: b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))) };
}

async function register(body: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const res = await w('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', ...body }),
  });
  expect(res.status, await res.clone().text()).toBe(201);
  return res.json();
}

function authorizeUrl(p: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) if (v !== undefined) q.set(k, v);
  return `/oauth/authorize?${q}`;
}

const requestField = (html: string): string => /name="request" value="([^"]+)"/.exec(html)![1];

/** GET the consent page; returns the signed request field. */
async function consent(clientId: string, challenge: string, extra: Record<string, string> = {}): Promise<string> {
  const res = await w(authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-123', resource: MCP, ...extra }));
  expect(res.status).toBe(200);
  return requestField(await res.text());
}

const submit = (request: string, passphrase: string, decision = 'approve', headers: Record<string, string> = {}) =>
  w('/oauth/authorize', { method: 'POST', headers: { ...FORM, origin: BASE, ...headers }, body: form({ request, passphrase, decision }) });

/** Approve with the passphrase; returns the code from the redirect. */
async function approve(request: string, passphrase = TEST_PASSPHRASE): Promise<string> {
  const res = await submit(request, passphrase);
  expect(res.status).toBe(303);
  const loc = new URL(res.headers.get('location')!);
  expect(loc.searchParams.get('error')).toBeNull();
  return loc.searchParams.get('code')!;
}

const exchange = (fields: Record<string, string>, headers: Record<string, string> = {}) =>
  w('/oauth/token', { method: 'POST', headers: { ...FORM, ...headers }, body: form({ grant_type: 'authorization_code', redirect_uri: REDIRECT, resource: MCP, ...fields }) });

/** Register → consent → approve → token. */
async function connect(name = 'Claude'): Promise<{ token: string; clientId: string; body: Record<string, unknown> }> {
  const { client_id } = await register({ client_name: name });
  const { verifier, challenge } = await pkce();
  const code = await approve(await consent(client_id, challenge));
  const res = await exchange({ client_id, code, code_verifier: verifier });
  expect(res.status, await res.clone().text()).toBe(200);
  const body = await res.json<Record<string, unknown>>();
  return { token: body.access_token as string, clientId: client_id, body };
}

const initialize = (token?: string) =>
  exports.default.fetch(MCP, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-11-25',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'vitest', version: '1' } } }),
  });

async function deviceList(): Promise<Device[]> {
  const login = await anon('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: TEST_PASSPHRASE }) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  return (await (await anon('/auth/devices', { headers: { cookie } })).json<{ devices: Device[] }>()).devices;
}

describe('OAuth for MCP', () => {
  it('serves protected resource metadata (root and /mcp) and the /mcp 401 points at it', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const res = await w(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(await res.json()).toEqual({ resource: MCP, authorization_servers: [BASE], bearer_methods_supported: ['header'], resource_name: 'Hermes' });
    }
    const res = await initialize();
    expect(res.status).toBe(401);
    const challenge = res.headers.get('www-authenticate')!;
    const url = /resource_metadata="([^"]+)"/.exec(challenge)![1];
    expect(url).toBe(`${BASE}/.well-known/oauth-protected-resource/mcp`);
    expect((await exports.default.fetch(url)).status).toBe(200);
  });

  it('serves authorization server metadata; other discovery paths are a JSON 404', async () => {
    const res = await w('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      issuer: BASE,
      authorization_endpoint: `${BASE}/oauth/authorize`,
      token_endpoint: `${BASE}/oauth/token`,
      registration_endpoint: `${BASE}/oauth/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: expect.arrayContaining(['none']),
      authorization_response_iss_parameter_supported: true,
    });
    const other = await w('/.well-known/oauth-protected-resource/elsewhere');
    expect(other.status).toBe(404);
    expect(other.headers.get('content-type')).toContain('application/json');
    const preflight = await w('/oauth/token', { method: 'OPTIONS', headers: { origin: 'https://inspector.example', 'access-control-request-method': 'POST' } });
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('the consent page needs a configured passphrase', async () => {
    const { client_id } = await register();
    const { challenge } = await pkce();
    const res = await w(authorizeUrl({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' }));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('not set up');
    // set it up for the rest of the file
    const setup = await anon('/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: TEST_PASSPHRASE }) });
    expect(setup.status).toBe(201);
  });

  it('registers public clients (RFC 7591) and validates redirect URIs', async () => {
    const reg = await register({ grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
    expect(reg).toMatchObject({ client_name: 'Claude', redirect_uris: [REDIRECT], grant_types: ['authorization_code'], response_types: ['code'], token_endpoint_auth_method: 'none' });
    expect(typeof reg.client_id).toBe('string');
    expect(reg.client_secret).toBeUndefined();
    expect(typeof reg.client_id_issued_at).toBe('number');

    // loopback http (any port at authorize time) and private-use schemes are fine
    await register({ redirect_uris: ['http://127.0.0.1:33418/callback', 'http://localhost:9999/cb', 'cursor://anysphere.cursor-mcp/oauth/callback'] });
    expect((await register({ client_name: undefined })).client_name).toBe('MCP client');

    const bad = async (body: unknown, error: string) => {
      const res = await w('/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error });
    };
    await bad({ client_name: 'x' }, 'invalid_redirect_uri');
    await bad({ redirect_uris: [] }, 'invalid_redirect_uri');
    await bad({ redirect_uris: ['http://example.com/cb'] }, 'invalid_redirect_uri');
    await bad({ redirect_uris: ['javascript:alert(1)'] }, 'invalid_redirect_uri');
    await bad({ redirect_uris: ['https://claude.ai/cb#frag'] }, 'invalid_redirect_uri');
    await bad({ redirect_uris: ['/relative'] }, 'invalid_redirect_uri');
    await bad({ redirect_uris: [REDIRECT], grant_types: ['client_credentials'] }, 'invalid_client_metadata');
    await bad({ redirect_uris: [REDIRECT], token_endpoint_auth_method: 'private_key_jwt' }, 'invalid_client_metadata');
    await bad('not json', 'invalid_client_metadata');
  });

  it('shows a framing-proof consent page naming the client and where it returns to', async () => {
    const { client_id } = await register({ client_name: '<b>Claude</b> & co' });
    const { challenge } = await pkce();
    const res = await w(authorizeUrl({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', resource: MCP }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('cache-control')).toBe('no-store');
    const html = await res.text();
    expect(html).toContain('&lt;b&gt;Claude&lt;/b&gt; &amp; co');
    expect(html).not.toContain('<b>Claude</b>');
    expect(html).toContain('claude.ai');
    expect(html).toContain('type="password"');
  });

  it('full flow: authorize → token → /mcp; stores only hashes; the grant is a 30-day agent device', async () => {
    const { client_id } = await register({ client_name: 'Claude Code' });
    const { verifier, challenge } = await pkce();
    const request = await consent(client_id, challenge);
    const before = Date.now();
    const res = await submit(request, TEST_PASSPHRASE);
    expect(res.status).toBe(303);
    const loc = new URL(res.headers.get('location')!);
    expect(`${loc.origin}${loc.pathname}`).toBe(REDIRECT);
    expect(loc.searchParams.get('state')).toBe('st-123');
    expect(loc.searchParams.get('iss')).toBe(BASE);
    const code = loc.searchParams.get('code')!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const codes = await env.DB.prepare('SELECT * FROM oauth_codes').all<Record<string, unknown>>();
    expect(JSON.stringify(codes.results)).not.toContain(code);

    const tok = await exchange({ client_id, code, code_verifier: verifier });
    expect(tok.status).toBe(200);
    expect(tok.headers.get('cache-control')).toBe('no-store');
    expect(tok.headers.get('access-control-allow-origin')).toBe('*');
    const body = await tok.json<Record<string, any>>();
    expect(body.token_type).toBe('Bearer');
    expect(body.access_token).toMatch(/^cad_[A-Za-z0-9_-]{43}$/);
    expect(body.refresh_token).toBeUndefined(); // no refresh: the access token already spans the 30-day window
    expect(body.expires_in).toBeGreaterThan(30 * 86400 - 60);
    expect(body.expires_in).toBeLessThanOrEqual(30 * 86400);

    const mcp = await initialize(body.access_token);
    expect(mcp.status).toBe(200);
    expect(JSON.stringify(await mcp.text())).toContain('hermes');
    // the same token works on the JSON API, like any device token
    expect((await anon('/settings', { headers: { authorization: `Bearer ${body.access_token}` } })).status).toBe(200);

    const device = (await deviceList()).find((d) => d.name === 'Claude Code')!;
    expect(Device.parse(device)).toMatchObject({ platform: 'agent', connectedVia: 'oauth' });
    expect(device.fingerprint).toMatch(/^[A-Za-z0-9_-]{8}$/);
    const approvedAt = (await env.DB.prepare('SELECT approved_at AS a FROM oauth_codes WHERE device_id = ?').bind(device.id).first<{ a: string }>())!.a;
    expect(Date.parse(approvedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(device.expiresAt) - Date.parse(approvedAt)).toBe(30 * DAY_MS);
    const rows = await env.DB.prepare('SELECT * FROM devices').all();
    expect(JSON.stringify(rows.results)).not.toContain(body.access_token.slice(4));
  });

  it('PKCE is mandatory (S256) and a wrong verifier burns the code', async () => {
    const { client_id } = await register();
    const { verifier, challenge } = await pkce();
    for (const extra of [{ code_challenge: undefined }, { code_challenge_method: 'plain' }, { code_challenge_method: undefined }, { code_challenge: 'short' }]) {
      const res = await w(authorizeUrl({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 's1', ...extra }));
      expect(res.status).toBe(303);
      const loc = new URL(res.headers.get('location')!);
      expect(loc.searchParams.get('error')).toBe('invalid_request');
      expect(loc.searchParams.get('state')).toBe('s1');
      expect(loc.searchParams.get('iss')).toBe(BASE);
    }
    const code = await approve(await consent(client_id, challenge));
    const wrong = await exchange({ client_id, code, code_verifier: (await pkce()).verifier });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ error: 'invalid_grant' });
    const retry = await exchange({ client_id, code, code_verifier: verifier });
    expect(retry.status).toBe(400);
    expect(await retry.json()).toMatchObject({ error: 'invalid_grant' });
    // a missing verifier is a malformed request
    const code2 = await approve(await consent(client_id, challenge));
    expect(await (await exchange({ client_id, code: code2 })).json()).toMatchObject({ error: 'invalid_request' });
  });

  it('redirect_uri must match exactly (any port for loopback); mismatches never redirect', async () => {
    const { client_id } = await register();
    const { verifier, challenge } = await pkce();
    for (const redirect_uri of ['https://claude.ai/api/mcp/auth_callback/x', 'https://evil.example/cb', undefined]) {
      const res = await w(authorizeUrl({ response_type: 'code', client_id, redirect_uri, code_challenge: challenge, code_challenge_method: 'S256' }));
      expect(res.status).toBe(400);
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('content-type')).toContain('text/html');
    }
    // a tampered client_id is an unknown client: no redirect either
    const tampered = await w(authorizeUrl({ response_type: 'code', client_id: client_id.slice(0, -2) + 'xx', redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' }));
    expect(tampered.status).toBe(400);
    expect(tampered.headers.get('location')).toBeNull();

    // the token request must repeat the same redirect_uri
    const code = await approve(await consent(client_id, challenge));
    const res = await exchange({ client_id, code, code_verifier: verifier, redirect_uri: 'https://claude.ai/other' });
    expect(await res.json()).toMatchObject({ error: 'invalid_grant' });

    // loopback: registered port 3000, the client may come back on another port, but the path must match
    const loop = await register({ redirect_uris: ['http://127.0.0.1:3000/callback'] });
    const ok = await w(authorizeUrl({ response_type: 'code', client_id: loop.client_id, redirect_uri: 'http://127.0.0.1:45678/callback', code_challenge: challenge, code_challenge_method: 'S256' }));
    expect(ok.status).toBe(200);
    const badPath = await w(authorizeUrl({ response_type: 'code', client_id: loop.client_id, redirect_uri: 'http://127.0.0.1:45678/other', code_challenge: challenge, code_challenge_method: 'S256' }));
    expect(badPath.status).toBe(400);
  });

  it('a code works once; replaying it revokes the token it produced', async () => {
    const { client_id } = await register({ client_name: 'Replayed' });
    const { verifier, challenge } = await pkce();
    const code = await approve(await consent(client_id, challenge));
    const first = await exchange({ client_id, code, code_verifier: verifier });
    expect(first.status).toBe(200);
    const { access_token } = await first.json<{ access_token: string }>();
    expect((await initialize(access_token)).status).toBe(200);
    const again = await exchange({ client_id, code, code_verifier: verifier });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: 'invalid_grant', error_description: expect.stringContaining('already used') });
    expect((await initialize(access_token)).status).toBe(401);
    expect((await deviceList()).some((d) => d.name === 'Replayed')).toBe(false);
    // and an unknown code is just invalid
    expect(await (await exchange({ client_id, code: 'A'.repeat(43), code_verifier: verifier })).json()).toMatchObject({ error: 'invalid_grant' });
  });

  it('codes expire after 5 minutes and belong to one client', async () => {
    const { client_id } = await register();
    const other = await register({ client_name: 'Other' });
    const { verifier, challenge } = await pkce();
    const code = await approve(await consent(client_id, challenge));
    expect(await (await exchange({ client_id: other.client_id, code, code_verifier: verifier })).json()).toMatchObject({ error: 'invalid_grant' });

    const late = await approve(await consent(client_id, challenge));
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 5 * 60_000 + 1000 });
    const res = await exchange({ client_id, code: late, code_verifier: verifier });
    expect(await res.json()).toMatchObject({ error: 'invalid_grant', error_description: expect.stringContaining('expired') });
  });

  it('wrong passphrase re-shows the page (shared login throttle); cancel returns access_denied', async () => {
    await resetThrottle();
    const { client_id } = await register();
    const { challenge } = await pkce();
    const request = await consent(client_id, challenge);
    const wrong = await submit(request, 'not the passphrase');
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get('location')).toBeNull();
    const html = await wrong.text();
    expect(html).toContain('That passphrase is not right.');
    expect(requestField(html)).toBeTruthy(); // can try again on the same page
    expect((await submit(request, '')).status).toBe(400);

    for (let i = 0; i < 4; i++) await submit(request, `wrong ${i}`);
    const locked = await submit(request, TEST_PASSPHRASE);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await locked.text()).toContain('Too many attempts');
    // the same lockout blocks the web login
    expect((await anon('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: TEST_PASSPHRASE }) })).status).toBe(429);
    await resetThrottle();

    const denied = await submit(request, '', 'deny');
    expect(denied.status).toBe(303);
    const loc = new URL(denied.headers.get('location')!);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('state')).toBe('st-123');
    expect(loc.searchParams.get('code')).toBeNull();
  });

  it('the consent form is pinned: tampered, expired or cross-origin submissions are refused', async () => {
    const { client_id } = await register();
    const { challenge } = await pkce();
    const request = await consent(client_id, challenge);
    expect((await submit(request.slice(0, -2) + 'xx', TEST_PASSPHRASE)).status).toBe(400);
    expect((await submit(request, TEST_PASSPHRASE, 'approve', { origin: 'https://evil.example' })).status).toBe(403);
    expect((await submit(request, TEST_PASSPHRASE, 'approve', { origin: 'null' })).status).toBe(403);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 11 * 60_000 });
    const expired = await submit(request, TEST_PASSPHRASE);
    expect(expired.status).toBe(400);
    expect(await expired.text()).toContain('expired');
  });

  it('resource (RFC 8707) must name this MCP server', async () => {
    const { client_id } = await register();
    const { verifier, challenge } = await pkce();
    const bad = await w(authorizeUrl({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', resource: 'https://evil.example/mcp' }));
    expect(bad.status).toBe(303);
    expect(new URL(bad.headers.get('location')!).searchParams.get('error')).toBe('invalid_target');
    // the bare origin and a trailing slash are accepted
    await consent(client_id, challenge, { resource: `${BASE}/` });
    const code = await approve(await consent(client_id, challenge, { resource: `${MCP}/` }));
    const res = await exchange({ client_id, code, code_verifier: verifier, resource: 'https://evil.example/mcp' });
    expect(await res.json()).toMatchObject({ error: 'invalid_target' });
  });

  it('rejects other grant types, unknown clients and (for confidential clients) a missing secret', async () => {
    expect(await (await exchange({ grant_type: 'refresh_token', refresh_token: 'x' })).json()).toMatchObject({ error: 'unsupported_grant_type' });
    expect(await (await exchange({ grant_type: 'client_credentials' })).json()).toMatchObject({ error: 'unsupported_grant_type' });
    const unknown = await exchange({ client_id: 'nope', code: 'x', code_verifier: 'y' });
    expect(unknown.status).toBe(401);
    expect(await unknown.json()).toMatchObject({ error: 'invalid_client' });

    const conf = await register({ client_name: 'Confidential', token_endpoint_auth_method: 'client_secret_post' });
    expect(typeof conf.client_secret).toBe('string');
    expect(conf.client_secret_expires_at).toBe(0);
    const { verifier, challenge } = await pkce();
    const code = await approve(await consent(conf.client_id, challenge));
    const noSecret = await exchange({ client_id: conf.client_id, code, code_verifier: verifier });
    expect(noSecret.status).toBe(401);
    expect(await noSecret.json()).toMatchObject({ error: 'invalid_client' });
    const code2 = await approve(await consent(conf.client_id, challenge));
    expect((await exchange({ client_id: conf.client_id, client_secret: conf.client_secret, code: code2, code_verifier: verifier })).status).toBe(200);
    // HTTP Basic works too
    const code3 = await approve(await consent(conf.client_id, challenge));
    const basic = btoa(`${encodeURIComponent(conf.client_id)}:${encodeURIComponent(conf.client_secret)}`);
    expect((await exchange({ code: code3, code_verifier: verifier }, { authorization: `Basic ${basic}` })).status).toBe(200);
  });

  it('access tokens stop working 30 days after the passphrase was entered', async () => {
    const approvedAt = Date.now();
    const { token, body } = await connect('Month long');
    expect((await initialize(token)).status).toBe(200);
    vi.useFakeTimers({ toFake: ['Date'], now: approvedAt + 30 * DAY_MS - 60_000 });
    expect((await initialize(token)).status).toBe(200);
    vi.useFakeTimers({ toFake: ['Date'], now: approvedAt + (body.expires_in as number) * 1000 + 5000 });
    const res = await initialize(token);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('error="invalid_token"');
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  it('revoking the device in Settings cuts the client off at once', async () => {
    const { token } = await connect('To revoke');
    expect((await initialize(token)).status).toBe(200);
    const device = (await deviceList()).find((d) => d.name === 'To revoke')!;
    const login = await anon('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passphrase: TEST_PASSPHRASE }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    expect((await anon(`/auth/devices/${device.id}`, { method: 'DELETE', headers: { cookie } })).status).toBe(204);
    expect((await initialize(token)).status).toBe(401);
  });

  it('changing the passphrase revokes OAuth tokens and voids pending codes', async () => {
    const { token } = await connect('Before change');
    const { client_id } = await register();
    const { verifier, challenge } = await pkce();
    const pending = await approve(await consent(client_id, challenge));
    expect((await initialize(token)).status).toBe(200);

    const change = await anon('/auth/change', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ current: TEST_PASSPHRASE, next: NEXT_PASSPHRASE }) });
    expect(change.status).toBe(200);
    expect((await initialize(token)).status).toBe(401);
    expect(await (await exchange({ client_id, code: pending, code_verifier: verifier })).json()).toMatchObject({ error: 'invalid_grant' });
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM oauth_codes').first<{ n: number }>())!.n).toBe(0);

    // the old passphrase no longer approves; the new one does
    const request = await consent(client_id, challenge);
    expect((await submit(request, TEST_PASSPHRASE)).status).toBe(401);
    await resetThrottle();
    const code = await approve(request, NEXT_PASSPHRASE);
    expect((await exchange({ client_id, code, code_verifier: verifier })).status).toBe(200);
  });
});
