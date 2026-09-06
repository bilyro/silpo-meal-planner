import { tool, type Tool } from 'ai';
import { z } from 'zod';
import type { SilpoMcpClient } from '../mcp/SilpoMcpClient.js';
import { ensureCartContext } from './cartContext.js';
import { saveSession, type SessionState } from './session.js';

const proposeMenuInput = z.object({
  days: z.number().int().positive(),
  dishes: z.array(
    z.object({
      day: z.number().int().positive(),
      dish: z.string(),
      ingredients: z.array(z.object({ name: z.string(), qty: z.string() })),
    }),
  ),
});

/**
 * Local (non-MCP) tools, spec §6.3. `record_resolution`/`finish_with_checkout` (Phase 5) land
 * later. `state` is mutated in place; the caller (runAgentTurn) persists it and reads
 * `state.stage` afterwards.
 */
export function localTools(userId: number, state: SessionState, mcp: SilpoMcpClient): Record<string, Tool> {
  return {
    propose_menu: tool({
      description:
        'Зберігає запропоноване меню (дні, страви, інгредієнти) і переводить розмову в стан очікування підтвердження користувача.',
      inputSchema: proposeMenuInput,
      execute: async (input) => {
        state.menu = input.dishes;
        state.stage = 'menu_proposed';
        await saveSession(userId, state);
        return { ok: true };
      },
    }),

    ensure_cart_context: tool({
      description:
        'Встановлює контекст кошика (адреса, філія, тип доставки, часовий слот). Виклич це ПЕРЕД ' +
        'будь-яким пошуком чи додаванням товарів, якщо контексту ще немає.',
      inputSchema: z.object({}),
      execute: async () => {
        const result = await ensureCartContext(mcp, state);
        await saveSession(userId, state);
        return result;
      },
    }),
  };
}
