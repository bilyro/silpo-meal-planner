/**
 * User-facing strings shared by more than one handler module. Lives in its own file rather than in
 * bot.ts because commands.ts needs them too, and bot.ts already imports commands.ts.
 */

/** Shown whenever an MCP call fails with NeedsAuthError — the tokens expired or were revoked. */
export const RELINK_MESSAGE = 'Ваш звʼязок із Сільпо застарів. Напишіть /start, щоб підʼєднатися знову.';
