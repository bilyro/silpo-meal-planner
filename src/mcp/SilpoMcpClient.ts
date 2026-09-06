import { tool, jsonSchema, type Tool, type JSONSchema7 } from 'ai';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { config } from '../config.js';
import * as repo from '../db/repo.js';
import { SilpoAuthProvider } from './SilpoAuthProvider.js';

export class NeedsAuthError extends Error {
  constructor(public readonly authorizationUrl: URL) {
    super('Silpo account not linked, or the link expired; user must (re-)authorize');
  }
}

function redirectUri(): string {
  return new URL('/auth/callback', config.PUBLIC_BASE_URL).toString();
}

function makeTransport(auth: SilpoAuthProvider): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(new URL(config.SILPO_MCP_URL), { authProvider: auth });
}

/** Completes the Authorization Code + PKCE exchange started by SilpoMcpClient.connect(). */
export async function completeAuthorization(userId: number, code: string, codeVerifier: string): Promise<void> {
  const auth = new SilpoAuthProvider(userId, redirectUri(), undefined, codeVerifier);
  await makeTransport(auth).finishAuth(code);
}

// Spec §4.5: exponential backoff with jitter, base 500ms, max 5 retries, only on 429 / transient
// network errors. StreamableHTTPError.code carries the HTTP status for non-2xx responses
// (verified against @modelcontextprotocol/sdk@1.30.0's streamableHttp.js); ECONNRESET-style
// failures surface as a fetch TypeError with a `cause.code` from Node's undici.
const RETRY_BASE_MS = 500;
const RETRY_MAX_ATTEMPTS = 5;

function isRetryable(err: unknown): boolean {
  if (err instanceof StreamableHTTPError && err.code === 429) return true;
  const cause = (err as { cause?: { code?: string } } | undefined)?.cause;
  if (cause?.code === 'ECONNRESET' || cause?.code === 'ETIMEDOUT') return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseToolResult<T>(res: Awaited<ReturnType<Client['callTool']>>): T {
  if (res.structuredContent) return res.structuredContent as T;
  const first = Array.isArray(res.content) ? res.content[0] : undefined;
  if (first && first.type === 'text') return JSON.parse(first.text) as T;
  return res.content as T;
}

/**
 * Per-user MCP client. connect() either succeeds (tokens already valid/refreshed) or throws
 * NeedsAuthError carrying the URL to send the user to — the caller decides how to present it
 * (an inline Telegram button today; the agent loop in Phase 3 will surface it as a reply).
 */
export class SilpoMcpClient {
  private client: Client | undefined;

  constructor(private readonly userId: number) {}

  async connect(): Promise<void> {
    let capturedUrl: URL | undefined;
    const auth = new SilpoAuthProvider(this.userId, redirectUri(), (url) => {
      capturedUrl = url;
    });
    const client = new Client({ name: 'silpo-meal-planner', version: '0.1.0' }, { capabilities: {} });
    try {
      await client.connect(makeTransport(auth));
    } catch (err) {
      if (err instanceof UnauthorizedError && capturedUrl) throw new NeedsAuthError(capturedUrl);
      throw err;
    }
    this.client = client;
  }

  /** Retry/backoff + tool_call_log wrapper shared by callTool() and every generated AI SDK tool. */
  private async callToolWithLogging<T>(name: string, args: Record<string, unknown>): Promise<T> {
    if (!this.client) throw new Error('SilpoMcpClient.connect() must succeed before calling tools');
    const client = this.client;
    const t0 = Date.now();
    let lastErr: unknown;
    for (let attempt = 0; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        const res = await client.callTool({ name, arguments: args });
        if (res.isError) throw new Error(`Tool ${name} failed: ${JSON.stringify(res.content)}`);
        const result = parseToolResult<T>(res);
        await repo.logToolCall({ userId: this.userId, tool: name, args, ok: true, ms: Date.now() - t0 });
        return result;
      } catch (err) {
        lastErr = err;
        if (attempt < RETRY_MAX_ATTEMPTS && isRetryable(err)) {
          const backoff = RETRY_BASE_MS * 2 ** attempt;
          await sleep(backoff + Math.random() * backoff * 0.5);
          continue;
        }
        break;
      }
    }
    await repo.logToolCall({
      userId: this.userId,
      tool: name,
      args,
      ok: false,
      ms: Date.now() - t0,
      error: lastErr instanceof Error ? lastErr.message : String(lastErr),
    });
    throw lastErr;
  }

  async callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.callToolWithLogging<T>(name, args);
  }

  /**
   * Exposes every Silpo MCP tool (spec §6.2 — all ~40, not a hand-picked subset) as an AI SDK
   * tool, routed through the same retry/backoff + tool_call_log path as callTool(). Must be
   * called after connect() has succeeded.
   */
  async toolsForAiSdk(): Promise<Record<string, Tool>> {
    if (!this.client) throw new Error('SilpoMcpClient.connect() must succeed before toolsForAiSdk()');
    const { tools } = await this.client.listTools();
    return Object.fromEntries(
      tools.map((t) => [
        t.name,
        tool({
          description: t.description ?? t.name,
          inputSchema: jsonSchema(t.inputSchema as JSONSchema7),
          execute: (args) => this.callToolWithLogging(t.name, args as Record<string, unknown>),
        }),
      ]),
    );
  }

  async close(): Promise<void> {
    await this.client?.close();
  }
}
