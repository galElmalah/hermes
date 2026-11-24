/**
 * Remote MCP server at `/mcp` for AI agents (docs/MCP.md).
 *
 * Transport: Streamable HTTP, stateless (no sessions, no Durable Objects, no new bindings — the
 * only state is D1 behind the JSON API). The protocol itself is the official TypeScript SDK in
 * ./server.ts, imported lazily on the first `/mcp` request; this module is the cheap, always-loaded
 * front door: path routing, Origin check and bearer auth.
 *
 * Auth: a device token (`Authorization: Bearer cad_…`, docs/MOBILE_API.md §1) — the same revocable,
 * 30-day tokens as the iPhone app. A client gets one either by OAuth (worker/oauth: the 401 below
 * points at the protected resource metadata, the owner approves with the passphrase) or pasted from
 * Settings → Devices → "Agent access (MCP)". Cookies are never accepted here. Tools reach the API
 * in-process with that same token (./api.ts).
 */
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { errorResponse } from '../lib/http';
import { resolvePrincipal } from '../middleware/auth';
import { resourceMetadataUrl } from '../oauth';
import { apiClient, type ApiFetch } from './api';

export const MCP_PATH = '/mcp';

/** True for the path `createMcpApp` serves (OAuth lives in worker/oauth; the rest is API / assets). */
export function isMcpRequest(req: Request): boolean {
  return new URL(req.url).pathname === MCP_PATH;
}

/** 401 with an RFC 6750 / RFC 9728 challenge: OAuth clients discover the authorization server from it. */
function unauthorized(req: Request, message: string, invalidToken: boolean): Response {
  let challenge = `Bearer realm="hermes", resource_metadata="${resourceMetadataUrl(req.url)}"`;
  if (invalidToken) challenge += ', error="invalid_token", error_description="Unknown, revoked or expired token"';
  return Response.json(
    {
      error: {
        code: 'unauthorized',
        message: `${message} Connect with OAuth (approve with your Hermes passphrase), or create a token in Hermes → Settings → Devices → Agent access (MCP) and send it as "Authorization: Bearer cad_…".`,
      },
    },
    { status: 401, headers: { 'WWW-Authenticate': challenge } },
  );
}

/**
 * Spec: "If the Origin header is present and invalid, servers MUST respond with HTTP 403" (DNS
 * rebinding). Non-browser clients send no Origin; a browser page may only call from this origin.
 */
function badOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false;
  try {
    return new URL(origin).host !== new URL(req.url).host;
  } catch {
    return true;
  }
}

/** The `/mcp` endpoint. `apiFetch` is the JSON API app's fetch (tools dispatch to it in-process). */
export function createMcpApp(apiFetch: ApiFetch) {
  return (
    new Hono<AppEnv>()
      .onError((err, c) => errorResponse(c, err))
      .all(MCP_PATH, async (c) => {
        if (badOrigin(c.req.raw)) {
          return c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Forbidden: invalid Origin' } }, 403);
        }
        const authorization = c.req.header('authorization');
        if (!authorization || !/^Bearer\s+\S/i.test(authorization.trim())) return unauthorized(c.req.raw, 'Missing bearer token.', false);
        const principal = await resolvePrincipal(c);
        if (principal?.kind !== 'device') return unauthorized(c.req.raw, 'Invalid, revoked or expired token.', true);

        const { serveMcp } = await import('./server');
        return serveMcp(c.req.raw, { api: apiClient(apiFetch, c.env, c.executionCtx, authorization) });
      })
  );
}
