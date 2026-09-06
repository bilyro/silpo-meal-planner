import type { Bot } from 'grammy';
import { logger } from '../logger.js';
import { SilpoMcpClient } from '../mcp/SilpoMcpClient.js';
import { escapeHtml } from './format.js';

interface ProfileResult {
  success: boolean;
  profile: { firstName: string | null; lastName: string | null };
}
interface FamilyResult {
  success: boolean;
  summary: string;
  members: unknown[];
  children: unknown[];
  pets: unknown[];
}
interface RestrictionsResult {
  success: boolean;
  summary: string;
  restrictions: unknown[];
}

/** Sent once, right after /auth/callback completes a link (spec §3.1 step 1, §8 Phase 2 step 2). */
export async function sendWelcomeMessage(bot: Bot, telegramChatId: string, userId: number): Promise<void> {
  const mcp = new SilpoMcpClient(userId);
  try {
    await mcp.connect();
    const [profile, family, restrictions] = await Promise.all([
      mcp.callTool<ProfileResult>('silpo_get_my_profile'),
      mcp.callTool<FamilyResult>('silpo_get_my_family'),
      mcp.callTool<RestrictionsResult>('silpo_get_my_food_restrictions'),
    ]);

    const name = profile.profile.firstName ?? '';
    const greeting = name ? `Готово, ${escapeHtml(name)}!` : 'Готово!';
    const familySize = family.members.length + family.children.length;
    const familyLine = family.summary || `сім'я з ${familySize} осіб`;
    const lines = [`${greeting} Я бачу вашу ${escapeHtml(familyLine)}.`];
    if (restrictions.restrictions.length > 0) {
      lines.push(`Обмеження харчування: ${escapeHtml(restrictions.summary)}.`);
    }
    if (family.pets.length > 0) {
      lines.push(`Також бачу ${family.pets.length} улюбленц${family.pets.length === 1 ? 'я' : 'ів'} 🐾`);
    }
    lines.push('\nНапишіть, що спланувати, напр.: «Сплануй вечері на 3 дні, без свинини, до 1200 грн».');

    await bot.api.sendMessage(telegramChatId, lines.join('\n'), { parse_mode: 'HTML' });
  } catch (err) {
    logger.error({ err, userId }, 'Failed to send post-link welcome message');
    await bot.api.sendMessage(
      telegramChatId,
      'Акаунт підʼєднано, але не вдалося завантажити профіль. Спробуйте /plan.',
    );
  } finally {
    await mcp.close();
  }
}
