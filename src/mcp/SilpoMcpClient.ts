import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { config } from '../config.js';
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

  async callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    if (!this.client) throw new Error('SilpoMcpClient.connect() must succeed before callTool()');
    const res = await this.client.callTool({ name, arguments: args });
    if (res.isError) throw new Error(`Tool ${name} failed: ${JSON.stringify(res.content)}`);
    if (res.structuredContent) return res.structuredContent as T;
    const first = Array.isArray(res.content) ? res.content[0] : undefined;
    if (first && first.type === 'text') return JSON.parse(first.text) as T;
    return res.content as T;
  }

  async close(): Promise<void> {
    await this.client?.close();
  }
}
