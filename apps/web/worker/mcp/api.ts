/**
 * In-process access to the JSON API for MCP tools.
 *
 * Tools do not re-implement handlers: they call the very same Hono routes the SPA and the iPhone
 * app use (validation, compliance decoration, re-pairing, Garmin "dirty" marking, background
 * recomputes…), dispatched in-process with the caller's own bearer token, so the auth middleware
 * still runs and nothing can be reached that the token could not reach over HTTP.
 */

import type { ExecutionContext } from 'hono';

/** Same signature as `app.fetch` (the Hono API app in worker/index.ts). */
export type ApiFetch = (req: Request, env: Env, ctx: ExecutionContext) => Response | Promise<Response>;

/** A non-2xx API response, carrying the API's `{ error: { code, message } }`. */
export class ApiCallError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ApiClient {
  get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T>;
  send<T>(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T>;
}

const INTERNAL_ORIGIN = 'https://mcp.internal';

export function apiClient(fetcher: ApiFetch, env: Env, ctx: ExecutionContext, authorization: string): ApiClient {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers = new Headers({ authorization, accept: 'application/json' });
    if (body !== undefined) headers.set('content-type', 'application/json');
    const res = await fetcher(
      new Request(`${INTERNAL_ORIGIN}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
      env,
      ctx,
    );
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!res.ok) {
      const err = (data as { error?: { code?: string; message?: string } } | null)?.error;
      throw new ApiCallError(res.status, err?.code ?? 'http_error', err?.message ?? `Request failed (${res.status})`);
    }
    return data as T;
  }
  return {
    get: (path, query) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) qs.set(k, String(v));
      const s = qs.toString();
      return call('GET', s ? `${path}?${s}` : path);
    },
    send: (method, path, body) => call(method, path, body),
  };
}
