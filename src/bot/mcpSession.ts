import type { Context } from 'grammy';
import { logger } from '../logger.js';
import { NeedsAuthError, SilpoMcpClient } from '../mcp/SilpoMcpClient.js';
import { relinkReply } from './messages.js';

/** Telegram stops showing "typing" after ~5s, so refresh it while a long tool chain runs. */
export function keepTyping(ctx: Context): () => void {
  void ctx.replyWithChatAction('typing').catch(() => {});
  const timer = setInterval(() => {
    ctx.replyWithChatAction('typing').catch(() => {});
  }, 4000);
  return () => clearInterval(timer);
}

/**
 * Wraps a Silpo MCP session: starts a typing indicator, connects, runs `action`, and always
 * closes — the connect/NeedsAuthError/finally-close skeleton every handler that talks to Silpo
 * needs. Previously copy-pasted across 5 call sites (bot.ts's menu_confirm, cart_build,
 * apply_promo, clear_confirm; commands.ts's /cart) with no structural link between them —
 * clear_confirm had already drifted from the others (missing the typing indicator).
 *
 * Only the NeedsAuthError branch is truly identical everywhere (relinkReply). Any OTHER error
 * still gets a handler-specific apology via `onError` rather than being collapsed into one
 * message: the global errorBoundary() middleware's generic fallback exists precisely because it
 * has no way to say "не вдалося зібрати кошик" vs "не вдалося застосувати промокод" — that
 * specificity is worth keeping, so this still catches and replies locally instead of rethrowing.
 */
export async function withMcpSession(
  ctx: Context,
  userId: number,
  onError: { log: string; reply: string },
  action: (mcp: SilpoMcpClient) => Promise<void>,
): Promise<void> {
  const stopTyping = keepTyping(ctx);
  const mcp = new SilpoMcpClient(userId);
  try {
    await mcp.connect();
    await action(mcp);
  } catch (err) {
    if (err instanceof NeedsAuthError) {
      await ctx.reply(...relinkReply(err));
      return;
    }
    logger.error({ err, userId }, onError.log);
    await ctx.reply(onError.reply);
  } finally {
    stopTyping();
    await mcp.close();
  }
}
