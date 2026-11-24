/**
 * The MCP server proper, built on the official TypeScript SDK (`@modelcontextprotocol/server`).
 * Loaded lazily by ./index.ts on the first `/mcp` request, so the SDK (≈ 600 KB of JS) never
 * costs the JSON API anything at isolate start-up.
 *
 * `createMcpHandler` serves MCP 2026-07-28 (per-request `_meta`, `server/discover`) natively and
 * 2025-era clients (`initialize` handshake; 2025-11-25 and earlier) through its stateless legacy
 * fallback: a fresh McpServer per HTTP request, no sessions, GET/DELETE → 405.
 */
import { McpServer, createMcpHandler, type CallToolResult } from '@modelcontextprotocol/server';
import { ApiCallError } from './api';
import { TOOLS, ToolError, type ToolContext } from './tools';

const SERVER_INFO = { name: 'hermes', title: 'Hermes training', version: '1.0.0' };

const INSTRUCTIONS = `Hermes is a single athlete's training platform (plan, Garmin sync, analysis). Call get_athlete_context first: it gives today's date in the athlete's timezone, thresholds and zones, upcoming races and current fitness/fatigue/form. All dates are YYYY-MM-DD local dates; all values are metric with the unit in the field name (Sec, M, Mps, W, Bpm, Kg) plus pace strings. Planned workouts are written in the app's workout text syntax (see create_workout). Changes are live in the athlete's calendar and may be sent to their watch; prefer skip_workout over delete_workout for sessions that were not done.`;

const toolResult = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const toolError = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

/** A fresh server with every tool bound to this request's API client. */
export function buildMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });
  for (const t of TOOLS) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: t.input, annotations: { title: t.title, ...t.annotations } },
      async (args: unknown) => {
        try {
          return toolResult(await t.run(args, ctx));
        } catch (e) {
          if (e instanceof ToolError) return toolError(e.message);
          if (e instanceof ApiCallError) return toolError(`${e.code}: ${e.message}`);
          console.error(`mcp tool ${t.name} failed`, e);
          return toolError('Unexpected server error');
        }
      },
    );
  }
  return server;
}

/** Serve one authenticated MCP HTTP request. */
export function serveMcp(req: Request, ctx: ToolContext): Promise<Response> {
  // Default response shaping: plain JSON unless a handler emits a notification first (ours never
  // do). `subscriptions/listen` streams are SSE with the SDK's keep-alive comments: there are no
  // change events to publish (the tool list is static), so they only idle until the client closes.
  const handler = createMcpHandler(() => buildMcpServer(ctx));
  return handler.fetch(req);
}
