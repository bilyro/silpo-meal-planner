/**
 * `withMcpSession` collapses the connect/NeedsAuthError/finally-close skeleton that used to be
 * copy-pasted across 5 call sites (bot.ts's menu_confirm, cart_build, apply_promo, clear_confirm;
 * commands.ts's /cart) — see src/bot/mcpSession.ts's header comment. A bug here breaks all 5 at
 * once, so this is tested directly rather than only through whichever handler happens to exercise
 * it in another test.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'grammy';

const mockConnect = vi.fn();
const mockClose = vi.fn();

vi.mock('../src/mcp/SilpoMcpClient.js', async () => {
  const actual = await vi.importActual<typeof import('../src/mcp/SilpoMcpClient.js')>(
    '../src/mcp/SilpoMcpClient.js',
  );
  return {
    ...actual,
    SilpoMcpClient: vi.fn().mockImplementation(function () {
      return { connect: mockConnect, close: mockClose };
    }),
  };
});

import { NeedsAuthError } from '../src/mcp/SilpoMcpClient.js';
import { withMcpSession } from '../src/bot/mcpSession.js';

function fakeCtx() {
  return {
    reply: vi.fn(async () => undefined),
    replyWithChatAction: vi.fn(async () => undefined),
  } as unknown as Context;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConnect.mockResolvedValue(undefined);
  mockClose.mockResolvedValue(undefined);
});

describe('withMcpSession', () => {
  it('connects, runs the action with the client, and closes on success', async () => {
    const ctx = fakeCtx();
    const action = vi.fn(async () => {});

    await withMcpSession(ctx, 1, { log: 'x', reply: 'y' }, action);

    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledTimes(1);
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('starts a typing indicator and stops it before returning', async () => {
    const ctx = fakeCtx();
    await withMcpSession(ctx, 1, { log: 'x', reply: 'y' }, vi.fn());

    expect(ctx.replyWithChatAction).toHaveBeenCalledWith('typing');
  });

  it('on NeedsAuthError, replies via relinkReply and does NOT use the handler-specific onError.reply', async () => {
    const ctx = fakeCtx();
    const err = new NeedsAuthError(new URL('https://silpo.example/authorize'));
    mockConnect.mockRejectedValue(err);

    await withMcpSession(ctx, 1, { log: 'x', reply: 'GENERIC APOLOGY SHOULD NOT APPEAR' }, vi.fn());

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const [replyText] = vi.mocked(ctx.reply).mock.calls[0]!;
    expect(replyText).not.toContain('GENERIC APOLOGY');
    expect(replyText).toContain('Підʼєднайте акаунт знову');
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('on any other error, logs and replies with the handler-specific onError.reply, and still closes', async () => {
    const ctx = fakeCtx();
    const action = vi.fn(async () => {
      throw new Error('boom');
    });

    await withMcpSession(ctx, 1, { log: 'something failed', reply: 'Не вдалося зробити щось.' }, action);

    expect(ctx.reply).toHaveBeenCalledWith('Не вдалося зробити щось.');
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it('closes the client even when connect() itself throws a non-auth error', async () => {
    const ctx = fakeCtx();
    mockConnect.mockRejectedValue(new Error('network blip'));

    await withMcpSession(ctx, 1, { log: 'x', reply: 'Спробуйте пізніше.' }, vi.fn());

    expect(mockClose).toHaveBeenCalledTimes(1);
    expect(ctx.reply).toHaveBeenCalledWith('Спробуйте пізніше.');
  });
});
