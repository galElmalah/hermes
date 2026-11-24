/**
 * OAuth 2.1 for the MCP endpoint (docs/MCP.md → OAuth), next to the pasted device token. Hermes is
 * both the protected resource (`/mcp`) and its own authorization server:
 *
 * - `GET /.well-known/oauth-protected-resource[/mcp]` — RFC 9728 metadata; `/mcp` 401s point here.
 * - `GET /.well-known/oauth-authorization-server` — RFC 8414 metadata.
 * - `POST /oauth/register` — RFC 7591 dynamic client registration. Clients are not stored: the
 *   client_id is an HMAC-signed blob carrying the name, redirect URIs and auth method; a
 *   confidential client's secret is an HMAC of its client_id. Registration is open and costs nothing.
 * - `GET/POST /oauth/authorize` — consent page; approving takes the Hermes passphrase (same check
 *   and throttle as `POST /api/auth/login`). Code + PKCE S256 only, exact redirect_uri match (any
 *   port for loopback, RFC 8252 §7.3), `state` round-tripped, `iss` in the response (RFC 9207).
 * - `POST /oauth/token` — authorization_code grant only. The access token is an ordinary device
 *   token (`cad_…`, platform `agent`, named after the client) that expires 30 days after the
 *   passphrase was entered. No refresh token: the access token already lasts the whole 30-day
 *   window a passphrase entry allows, so a refresh token could add nothing but a second secret.
 *   When it expires, `/mcp` answers 401 and the client runs this flow again.
 *
 * Because access tokens are device rows, everything else is shared with device tokens: Settings →
 * Devices lists and revokes them, a passphrase change deletes them (and pending codes), and `/mcp`
 * tools reach the JSON API in-process with the same token.
 *
 * Consent CSRF: the form carries a signed, 10-minute request blob (it pins exactly what was shown)
 * and needs the passphrase, which a cross-site page cannot supply; foreign `Origin`s are refused.
 * The page cannot be framed.
 */
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv } from '../env';
import { ApiError, errorResponse } from '../lib/http';
import { b64uDecode, b64uEncode, signToken, timingSafeEqual, verifyToken } from '../lib/crypto';
import { limitBody } from '../middleware/limits';
import { createDevice, forgetDevice, hashDeviceToken, readAuthState } from '../middleware/auth';
import { deleteDevice } from '../db/devices';
import { claimOAuthCode, findOAuthCode, insertOAuthCode, linkOAuthCodeStmt } from '../db/oauth';
import { authenticate } from '../routes/auth';
import { consentPage, errorPage } from './page';

export const MCP_RESOURCE_PATH = '/mcp';
const PRM_PATH = '/.well-known/oauth-protected-resource';
/** Authorization codes live this long. */
const CODE_TTL_SEC = 5 * 60;
/** The consent form must be submitted within this long of opening it. */
const REQUEST_TTL_SEC = 10 * 60;
const DEFAULT_CLIENT_NAME = 'MCP client';
const MAX_REDIRECT_URIS = 10;

/** True for the paths this app serves. */
export function isOAuthRequest(req: Request): boolean {
  const path = new URL(req.url).pathname;
  return path.startsWith('/.well-known/oauth-') || path.startsWith('/oauth/');
}

const originOf = (c: Context<AppEnv>): string => new URL(c.req.url).origin;
const resourceOf = (origin: string): string => origin + MCP_RESOURCE_PATH;

/** The protected resource metadata URL that `/mcp` 401s advertise. */
export const resourceMetadataUrl = (requestUrl: string): string => new URL(requestUrl).origin + PRM_PATH + MCP_RESOURCE_PATH;

// ───────────────────────────── signed values ─────────────────────────────

type AuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';
const AUTH_METHODS: readonly AuthMethod[] = ['none', 'client_secret_post', 'client_secret_basic'];

/** What a client_id carries. */
interface ClientPayload {
  k: 'client';
  n: string; // client_name
  r: string[]; // redirect_uris
  a: AuthMethod;
  t: number; // issued at, unix seconds
}

/** What the consent form carries (everything validated on GET, pinned for the POST). */
interface RequestPayload {
  k: 'authz';
  c: string; // client_id
  n: string; // client_name
  u: string; // redirect_uri
  ch: string; // code_challenge (S256)
  s?: string; // state
  r?: string; // resource
  exp: number; // unix seconds
}

/** Own key, so these blobs can never be confused with session cookies. */
function oauthSecret(env: Env): string {
  if (!env.SESSION_SECRET) throw new ApiError(500, 'misconfigured', 'SESSION_SECRET is not configured');
  return `${env.SESSION_SECRET}:oauth`;
}

async function readClient(env: Env, clientId: string | undefined): Promise<ClientPayload | null> {
  if (!clientId || clientId.length > 8192) return null;
  const p = await verifyToken<ClientPayload>(clientId, oauthSecret(env));
  return p && p.k === 'client' && Array.isArray(p.r) && typeof p.n === 'string' && AUTH_METHODS.includes(p.a) ? p : null;
}

/** A confidential client's secret: HMAC of its client_id (nothing to store). */
async function clientSecretOf(env: Env, clientId: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`${oauthSecret(env)}:secret`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64uEncode(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(clientId)));
}

// ───────────────────────────── validation helpers ─────────────────────────────

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const FORBIDDEN_SCHEMES = new Set(['javascript', 'data', 'file', 'vbscript', 'blob', 'about', 'ws', 'wss', 'ftp']);

/** Why a redirect URI cannot be registered, or null when it is fine. */
function redirectProblem(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw || raw.length > 2048) return 'redirect URIs must be non-empty strings';
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return `${raw} is not an absolute URL`;
  }
  if (u.hash || raw.includes('#')) return `${raw} must not contain a fragment`;
  const scheme = u.protocol.slice(0, -1).toLowerCase();
  if (scheme === 'https') return null;
  if (scheme === 'http') return LOOPBACK.has(u.hostname) ? null : `${raw}: plain http is only allowed for loopback addresses`;
  if (FORBIDDEN_SCHEMES.has(scheme)) return `${raw}: the ${scheme}: scheme is not allowed`;
  return null; // private-use scheme of a native app (RFC 8252 §7.1)
}

/** Exact match, except that a loopback http redirect may use any port (RFC 8252 §7.3). */
function redirectMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  try {
    const a = new URL(registered);
    const b = new URL(requested);
    if (a.protocol !== 'http:' || b.protocol !== 'http:' || !LOOPBACK.has(a.hostname)) return false;
    a.port = '';
    b.port = '';
    return a.href === b.href;
  } catch {
    return false;
  }
}

/** What the consent page shows as the destination: host[:port], or `scheme:` for an app link. */
function redirectTarget(uri: string): string {
  const u = new URL(uri);
  return u.protocol === 'https:' || u.protocol === 'http:' ? u.host : `${u.protocol}//${u.host}${u.pathname}`;
}

/**
 * RFC 8707 resource → canonical form when it names this MCP server (`<origin>/mcp`, or the bare
 * origin), else null. Scheme/host case and a trailing slash are tolerated.
 */
function canonicalResource(origin: string, raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.hash || u.search || u.origin !== origin) return null;
    const path = u.pathname.replace(/\/+$/, '');
    return path === '' || path === MCP_RESOURCE_PATH ? resourceOf(origin) : null;
  } catch {
    return null;
  }
}

const PKCE_CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;

async function s256(verifier: string): Promise<string> {
  return b64uEncode(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

// ───────────────────────────── responses ─────────────────────────────

const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

/** RFC 6749 §5.2 error body. */
function oauthError(error: string, description: string, status: 400 | 401 = 400, extra: Record<string, string> = {}): Response {
  return Response.json({ error, error_description: description }, { status, headers: { ...NO_STORE, ...extra } });
}

/** HTML for the consent flow: never cached, never framed. */
function html(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      ...NO_STORE,
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      // not no-referrer: that would make the browser send `Origin: null` on the page's own POST
      'Referrer-Policy': 'same-origin',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  });
}

/** Back to the client with `code` or `error` (+ `state`, + `iss` per RFC 9207). 303: never re-POST. */
function redirectBack(redirectUri: string, params: Record<string, string | undefined>): Response {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return new Response(null, { status: 303, headers: { Location: u.href, ...NO_STORE, 'Referrer-Policy': 'no-referrer' } });
}

// ───────────────────────────── the authorization request ─────────────────────────────

type Checked = { ok: true; req: RequestPayload } | { ok: false; response: Response };

/**
 * RFC 6749 §4.1.2.1: problems with client_id / redirect_uri are shown here and never redirected;
 * everything else goes back to the (now trusted) redirect URI as an error.
 */
async function checkAuthorizationRequest(c: Context<AppEnv>, q: Record<string, string | undefined>): Promise<Checked> {
  const origin = originOf(c);
  const fail = (title: string, message: string): Checked => ({ ok: false, response: html(errorPage(title, message), 400) });
  const client = await readClient(c.env, q.client_id);
  if (!client) return fail('Unknown app', 'This app is not registered with this Hermes server (or its registration is no longer valid). Remove and add the server again in the app.');
  const redirectUri = q.redirect_uri;
  if (!redirectUri) return fail('Missing return address', 'The app did not say where to return after signing in (redirect_uri).');
  if (!client.r.some((r) => redirectMatches(r, redirectUri))) return fail('Unknown return address', 'The app asked to return to an address it did not register.');

  const back = (error: string, description: string): Checked => ({
    ok: false,
    response: redirectBack(redirectUri, { error, error_description: description, state: q.state, iss: origin }),
  });
  if (q.response_type !== 'code') return back('unsupported_response_type', 'Only response_type=code is supported');
  if (!q.code_challenge || q.code_challenge_method !== 'S256') return back('invalid_request', 'PKCE is required: code_challenge with code_challenge_method=S256');
  if (!PKCE_CHALLENGE_RE.test(q.code_challenge)) return back('invalid_request', 'code_challenge must be a base64url SHA-256 (43 characters)');
  let resource: string | undefined;
  if (q.resource !== undefined) {
    const r = canonicalResource(origin, q.resource);
    if (!r) return back('invalid_target', `resource must be ${resourceOf(origin)}`);
    resource = r;
  }
  if (q.state !== undefined && q.state.length > 2048) return back('invalid_request', 'state is too long');

  return {
    ok: true,
    req: {
      k: 'authz',
      c: q.client_id!,
      n: client.n,
      u: redirectUri,
      ch: q.code_challenge,
      s: q.state,
      r: resource,
      exp: Math.floor(Date.now() / 1000) + REQUEST_TTL_SEC,
    },
  };
}

async function renderConsent(c: Context<AppEnv>, req: RequestPayload, error?: string, status = 200, extra: Record<string, string> = {}): Promise<Response> {
  const request = await signToken(req, oauthSecret(c.env));
  return html(consentPage({ clientName: req.n, redirectTarget: redirectTarget(req.u), request, error }), status, extra);
}

/** Foreign (or opaque) Origin on the consent POST → refuse. Browsers send Origin on form POSTs. */
function foreignOrigin(c: Context<AppEnv>): boolean {
  const o = c.req.header('origin');
  if (!o) return false;
  try {
    return new URL(o).host !== new URL(c.req.url).host;
  } catch {
    return true;
  }
}

// ───────────────────────────── app ─────────────────────────────

/** Discovery, registration and token endpoints are called by (possibly browser-based) clients: open CORS, no credentials. */
const openCors = cors({ origin: '*', allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['authorization', 'content-type', 'mcp-protocol-version'], maxAge: 86400 });

export const oauthApp = new Hono<AppEnv>()
  .onError((err, c) => errorResponse(c, err))
  .use('/.well-known/*', openCors)
  .use('/oauth/register', openCors)
  .use('/oauth/token', openCors)

  // ── RFC 9728: at the root and path-suffixed for /mcp (clients try both) ──
  .get(PRM_PATH, (c) => c.json(protectedResourceMetadata(originOf(c))))
  .get(PRM_PATH + MCP_RESOURCE_PATH, (c) => c.json(protectedResourceMetadata(originOf(c))))

  // ── RFC 8414 ──
  .get('/.well-known/oauth-authorization-server', (c) => {
    const origin = originOf(c);
    return c.json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code'],
      token_endpoint_auth_methods_supported: AUTH_METHODS,
      code_challenge_methods_supported: ['S256'],
      authorization_response_iss_parameter_supported: true,
      service_documentation: 'https://modelcontextprotocol.io/specification/draft/basic/authorization',
    });
  })
  .get('/.well-known/oauth-*', (c) => c.json({ error: { code: 'not_found', message: 'No such metadata document' } }, 404))

  // ── RFC 7591 ──
  .post('/oauth/register', limitBody(64 * 1024), async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return oauthError('invalid_client_metadata', 'Expected a JSON object');
    const uris = body.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
      return oauthError('invalid_redirect_uri', `redirect_uris must list 1–${MAX_REDIRECT_URIS} URIs`);
    }
    for (const u of uris) {
      const problem = redirectProblem(u);
      if (problem) return oauthError('invalid_redirect_uri', problem);
    }
    const grantTypes = body.grant_types;
    if (grantTypes !== undefined && !(Array.isArray(grantTypes) && grantTypes.includes('authorization_code'))) {
      return oauthError('invalid_client_metadata', 'grant_types must include authorization_code');
    }
    const responseTypes = body.response_types;
    if (responseTypes !== undefined && !(Array.isArray(responseTypes) && responseTypes.includes('code'))) {
      return oauthError('invalid_client_metadata', 'response_types must include code');
    }
    const method = body.token_endpoint_auth_method ?? 'none';
    if (!AUTH_METHODS.includes(method as AuthMethod)) {
      return oauthError('invalid_client_metadata', `token_endpoint_auth_method must be one of ${AUTH_METHODS.join(', ')}`);
    }
    const name = (str(body.client_name) ?? '').replace(/\s+/g, ' ').trim().slice(0, 64) || DEFAULT_CLIENT_NAME;
    const issuedAt = Math.floor(Date.now() / 1000);
    const payload: ClientPayload = { k: 'client', n: name, r: uris as string[], a: method as AuthMethod, t: issuedAt };
    const clientId = await signToken(payload, oauthSecret(c.env));
    return c.json(
      {
        client_id: clientId,
        client_id_issued_at: issuedAt,
        ...(payload.a === 'none' ? {} : { client_secret: await clientSecretOf(c.env, clientId), client_secret_expires_at: 0 }),
        client_name: name,
        redirect_uris: payload.r,
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: payload.a,
      },
      201,
      NO_STORE,
    );
  })

  // ── consent ──
  .get('/oauth/authorize', async (c) => {
    const checked = await checkAuthorizationRequest(c, c.req.query());
    if (!checked.ok) return checked.response;
    if (!(await readAuthState(c.env.DB, true)).configured) {
      return html(errorPage('Hermes is not set up yet', 'Open Hermes in your browser and choose a passphrase first.'), 400);
    }
    return renderConsent(c, checked.req);
  })
  .post('/oauth/authorize', limitBody(32 * 1024), async (c) => {
    if (foreignOrigin(c)) return html(errorPage('Request refused', 'This form can only be submitted from Hermes itself.'), 403);
    const form = await c.req.parseBody();
    const signed = str(form.request);
    const req = signed ? await verifyToken<RequestPayload>(signed, oauthSecret(c.env)) : null;
    if (!req || req.k !== 'authz' || !(req.exp > Date.now() / 1000)) {
      return html(errorPage('This sign-in page expired', 'Sign-in pages are valid for 10 minutes.'), 400);
    }
    const origin = originOf(c);
    if (str(form.decision) !== 'approve') {
      return redirectBack(req.u, { error: 'access_denied', error_description: 'The owner declined', state: req.s, iss: origin });
    }
    const passphrase = str(form.passphrase) ?? '';
    if (!passphrase) return renderConsent(c, req, 'Enter your passphrase.', 400);
    let epoch: number;
    try {
      epoch = await authenticate(c.env.DB, passphrase.slice(0, 1024));
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      if (e.code === 'invalid_passphrase') return renderConsent(c, req, 'That passphrase is not right.', 401);
      if (e.status === 429) return renderConsent(c, req, e.message, 429, { 'Retry-After': String(Math.max(1, Math.ceil(e.retryAfterSec ?? 1))) });
      return html(errorPage('Can’t sign in', e.message), e.status === 400 ? 400 : 500);
    }
    const code = b64uEncode(crypto.getRandomValues(new Uint8Array(32)));
    const now = Date.now();
    await insertOAuthCode(c.env.DB, {
      codeHash: await hashDeviceToken(code),
      clientId: req.c,
      clientName: req.n,
      redirectUri: req.u,
      codeChallenge: req.ch,
      resource: req.r ?? null,
      epoch,
      approvedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + CODE_TTL_SEC * 1000).toISOString(),
    });
    return redirectBack(req.u, { code, state: req.s, iss: origin });
  })

  // ── token ──
  .post('/oauth/token', limitBody(64 * 1024), async (c) => {
    const type = c.req.header('content-type') ?? '';
    const form: Record<string, unknown> = type.includes('application/json')
      ? (((await c.req.json().catch(() => null)) as Record<string, unknown> | null) ?? {})
      : await c.req.parseBody().catch(() => ({}));

    // client authentication: public clients send client_id only; confidential ones a secret too
    let clientId = str(form.client_id);
    let secret = str(form.client_secret);
    const basic = /^Basic\s+(\S+)$/i.exec(c.req.header('authorization') ?? '');
    if (basic) {
      try {
        const [id, sec] = atob(basic[1]).split(':');
        clientId = decodeURIComponent(id ?? '');
        secret = decodeURIComponent(sec ?? '');
      } catch {
        return oauthError('invalid_client', 'Malformed Basic credentials', 401, { 'WWW-Authenticate': 'Basic' });
      }
    }
    if (str(form.grant_type) !== 'authorization_code') return oauthError('unsupported_grant_type', 'Only grant_type=authorization_code is supported');
    const client = await readClient(c.env, clientId);
    if (!client || !clientId) return oauthError('invalid_client', 'Unknown client_id', 401);
    if (client.a !== 'none' || secret !== undefined) {
      const expected = await clientSecretOf(c.env, clientId);
      if (!secret || !timingSafeEqual(new TextEncoder().encode(secret), new TextEncoder().encode(expected))) {
        return oauthError('invalid_client', 'Client authentication failed', 401);
      }
    }

    const code = str(form.code);
    const verifier = str(form.code_verifier);
    const redirectUri = str(form.redirect_uri);
    if (!code || !verifier || !redirectUri) return oauthError('invalid_request', 'code, code_verifier and redirect_uri are required');

    const codeHash = await hashDeviceToken(code);
    const now = Date.now();
    const grant = await claimOAuthCode(c.env.DB, codeHash, new Date(now).toISOString());
    if (!grant) {
      // RFC 6749 §4.1.2 / OAuth 2.1: a reused code revokes what it produced
      const used = await findOAuthCode(c.env.DB, codeHash);
      if (used?.deviceId) {
        await deleteDevice(c.env.DB, used.deviceId);
        forgetDevice(used.deviceId);
      }
      return oauthError('invalid_grant', used ? 'Authorization code already used' : 'Unknown authorization code');
    }
    // the code is spent from here on, whatever happens next
    if (!(Date.parse(grant.expiresAt) > now)) return oauthError('invalid_grant', 'Authorization code expired');
    if (grant.clientId !== clientId) return oauthError('invalid_grant', 'Authorization code was issued to another client');
    if (grant.redirectUri !== redirectUri) return oauthError('invalid_grant', 'redirect_uri does not match the authorization request');
    if (!PKCE_VERIFIER_RE.test(verifier) || !timingSafeEqual(b64uDecode(await s256(verifier)), b64uDecode(grant.codeChallenge))) {
      return oauthError('invalid_grant', 'PKCE verification failed');
    }
    const origin = originOf(c);
    const resource = str(form.resource);
    if (resource !== undefined) {
      const r = canonicalResource(origin, resource);
      if (!r || (grant.resource && grant.resource !== r)) return oauthError('invalid_target', `resource must be ${resourceOf(origin)}`);
    }
    const state = await readAuthState(c.env.DB, true);
    if (!state.configured || state.epoch !== grant.epoch) return oauthError('invalid_grant', 'The passphrase changed since this code was issued');

    const approvedAt = Date.parse(grant.approvedAt);
    const { token, device } = await createDevice(c.env.DB, { name: grant.clientName, platform: 'agent', signedInAt: approvedAt, via: 'oauth' }, (deviceId) => [
      linkOAuthCodeStmt(c.env.DB, codeHash, deviceId),
    ]);
    const expiresIn = Math.max(1, Math.floor((Date.parse(device.expiresAt) - now) / 1000));
    return c.json({ access_token: token, token_type: 'Bearer', expires_in: expiresIn }, 200, NO_STORE);
  })
  .all('/oauth/*', (c) => c.json({ error: { code: 'not_found', message: 'No such endpoint' } }, 404));

function protectedResourceMetadata(origin: string) {
  return {
    resource: resourceOf(origin),
    authorization_servers: [origin],
    bearer_methods_supported: ['header'],
    resource_name: 'Hermes',
  };
}
