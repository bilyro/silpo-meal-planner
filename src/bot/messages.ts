/**
 * User-facing strings shared by more than one handler module. Lives in its own file rather than in
 * bot.ts because commands.ts needs them too, and bot.ts already imports commands.ts.
 */

import { InlineKeyboard } from 'grammy';
import type { NeedsAuthError } from '../mcp/SilpoMcpClient.js';

/** Fallback for a 401 we could not turn into an authorize URL — the user has to start over. */
export const RELINK_MESSAGE = 'Ваш звʼязок із Сільпо застарів. Напишіть /start, щоб підʼєднатися знову.';

/**
 * Reply for a NeedsAuthError, as `ctx.reply(...relinkReply(err))`.
 *
 * When the SDK got far enough to mint an authorize URL — the usual case, since a failed refresh
 * falls through to a fresh authorization — the user gets a button and is one tap from re-linked.
 * Telling someone whose session just expired to go and type /start is a needless extra step, and
 * spec §4 asks for a re-link *prompt*, not a re-link instruction.
 */
// A fixed-length tuple rather than a union of tuples: TS refuses to spread a union into a call
// ("A spread argument must either have a tuple type…"), and ctx.reply's second parameter is
// optional, so passing undefined is the same as omitting it.
export function relinkReply(err: NeedsAuthError): [string, { reply_markup: InlineKeyboard } | undefined] {
  if (!err.authorizationUrl) return [RELINK_MESSAGE, undefined];
  return [
    'Ваш звʼязок із Сільпо застарів. Підʼєднайте акаунт знову:',
    { reply_markup: new InlineKeyboard().url('🔐 Підʼєднати Сільпо', err.authorizationUrl.toString()) },
  ];
}
