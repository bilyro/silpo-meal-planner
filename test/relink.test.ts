/**
 * Spec §4: "Handle 401 by refreshing once, then falling back to a re-link prompt." The MCP SDK's
 * transport does the refresh; these cover the fallback, which is ours.
 *
 * The subtle half is the model path. A NeedsAuthError thrown inside a model-issued tool call never
 * reaches runAgentTurn's catch — ai@7's executeToolCall catches a throwing `execute` and turns it
 * into a tool-error fed back to the model — so the client records the failure and runAgentTurn
 * checks that flag after the loop. Without that, an expired token produced a vague model apology
 * and no way to re-link.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config.js', () => ({
  config: {
    TELEGRAM_BOT_TOKEN: 'test',
    ANTHROPIC_API_KEY: 'test',
    PUBLIC_BASE_URL: 'https://example.invalid',
    SILPO_MCP_URL: 'https://example.invalid/mcp',
    DATABASE_URL: 'postgres://test',
    LOG_LEVEL: 'silent',
    MAX_TOOL_CALLS_PER_TURN: 25,
    TURN_TIMEOUT_MS: 60_000,
    PORT: 3000,
    AGENT_MODEL: 'test-model',
  },
}));

vi.mock('../src/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

vi.mock('../src/db/repo.js', () => ({
  logToolCall: vi.fn(async () => {}),
  getRecentMessages: vi.fn(async () => []),
  appendMessages: vi.fn(async () => {}),
  getSessionState: vi.fn(async () => undefined),
  saveSessionState: vi.fn(async () => {}),
}));

vi.mock('@ai-sdk/anthropic', () => ({ anthropic: vi.fn(() => ({ modelId: 'test-model' })) }));

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: vi.fn(),
}));

import { generateText } from 'ai';
import * as repo from '../src/db/repo.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { NeedsAuthError, SilpoMcpClient } from '../src/mcp/SilpoMcpClient.js';
import { runAgentTurn } from '../src/agent/runAgentTurn.js';
import { RELINK_MESSAGE, relinkReply } from '../src/bot/messages.js';

const generateTextMock = vi.mocked(generateText);
const AUTH_URL = 'https://mcp.silpo.ua/authorize?client_id=abc';

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

/** A connected-looking client over a fake MCP `Client` whose calls fail the way an expired token does. */
function clientThatGets401() {
  const mcp = new SilpoMcpClient(42);
  (mcp as unknown as { client: unknown }).client = {
    // What StreamableHTTPClientTransport throws once it has tried auth() and been told to redirect.
    callTool: vi.fn(async () => {
      throw new UnauthorizedError();
    }),
  };
  return mcp;
}

describe('a 401 that cannot be refreshed', () => {
  it('surfaces as NeedsAuthError from a tool call, not a raw UnauthorizedError', async () => {
    const mcp = clientThatGets401();
    await expect(mcp.callTool('silpo_get_my_profile')).rejects.toBeInstanceOf(NeedsAuthError);
  });

  it('is recorded on the client, because a throw from a model tool call is swallowed by the AI SDK', async () => {
    const mcp = clientThatGets401();
    expect(mcp.needsAuth).toBeUndefined();

    await expect(mcp.callTool('silpo_get_my_profile')).rejects.toThrow();

    expect(mcp.needsAuth).toBeInstanceOf(NeedsAuthError);
  });

  it('carries the authorize URL the auth provider captured', async () => {
    const mcp = clientThatGets401();
    // Written by the provider's redirectToAuthorization callback during connect(); set directly
    // here because reaching it for real would mean standing up an OAuth server.
    (mcp as unknown as { pendingAuthUrl: URL }).pendingAuthUrl = new URL(AUTH_URL);

    await expect(mcp.callTool('silpo_get_my_profile')).rejects.toMatchObject({
      authorizationUrl: new URL(AUTH_URL),
    });
  });

  it('still logs the failed call — a suppressed 401 must not vanish from tool_call_log', async () => {
    const mcp = clientThatGets401();
    await expect(mcp.callTool('silpo_get_my_profile')).rejects.toThrow();

    expect(repo.logToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 42, tool: 'silpo_get_my_profile', ok: false }),
    );
  });
});

describe('runAgentTurn on a mid-turn 401', () => {
  function stubMcp(onTools: (client: SilpoMcpClient) => void) {
    vi.spyOn(SilpoMcpClient.prototype, 'connect').mockResolvedValue(undefined);
    vi.spyOn(SilpoMcpClient.prototype, 'close').mockResolvedValue(undefined);
    vi.spyOn(SilpoMcpClient.prototype, 'toolsForAiSdk').mockImplementation(async function (
      this: SilpoMcpClient,
    ) {
      onTools(this);
      return {};
    });
  }

  it('answers with the re-link prompt instead of whatever the model said', async () => {
    stubMcp((client) => {
      client.needsAuth = new NeedsAuthError(new URL(AUTH_URL));
    });
    // The model, having been handed the tool error, apologises vaguely — exactly the reply the
    // user used to be left with.
    generateTextMock.mockResolvedValue({ text: 'Вибачте, сталася помилка.' } as never);

    const result = await runAgentTurn(42, 'меню на 3 дні');

    expect(result.text).toContain(AUTH_URL);
    expect(result.text).not.toContain('Вибачте');
    expect(result.stage).toBe('need_auth');
  });

  it('does not persist the model apology as a real assistant reply', async () => {
    stubMcp((client) => {
      client.needsAuth = new NeedsAuthError(new URL(AUTH_URL));
    });
    generateTextMock.mockResolvedValue({ text: 'Вибачте, сталася помилка.' } as never);

    await runAgentTurn(42, 'меню на 3 дні');

    expect(repo.appendMessages).not.toHaveBeenCalled();
  });

  it('falls back to the /start message when no authorize URL was captured', async () => {
    stubMcp((client) => {
      client.needsAuth = new NeedsAuthError(undefined);
    });
    generateTextMock.mockResolvedValue({ text: 'Вибачте.' } as never);

    const result = await runAgentTurn(42, 'меню на 3 дні');

    expect(result.text).toBe(RELINK_MESSAGE);
    expect(result.stage).toBe('need_auth');
  });

  it('leaves a healthy turn alone', async () => {
    stubMcp(() => {});
    generateTextMock.mockResolvedValue({ text: 'Ось меню' } as never);

    const result = await runAgentTurn(42, 'меню на 3 дні');

    expect(result.text).toBe('Ось меню');
    expect(result.stage).not.toBe('need_auth');
    expect(repo.appendMessages).toHaveBeenCalledTimes(1);
  });
});

describe('relinkReply', () => {
  it('offers a one-tap button when there is a URL', () => {
    const [text, other] = relinkReply(new NeedsAuthError(new URL(AUTH_URL)));

    expect(text).toContain('Підʼєднайте акаунт знову');
    const button = other?.reply_markup.inline_keyboard[0]?.[0];
    expect(button).toMatchObject({ text: '🔐 Підʼєднати Сільпо', url: AUTH_URL });
  });

  it('falls back to asking for /start when there is none', () => {
    const [text, other] = relinkReply(new NeedsAuthError(undefined));

    expect(text).toBe(RELINK_MESSAGE);
    // undefined rather than an empty markup: ctx.reply's second arg is optional, and an empty
    // keyboard would render as a stray blank attachment.
    expect(other).toBeUndefined();
  });
});
