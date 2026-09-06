import { tool, type Tool } from 'ai';
import { z } from 'zod';
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
 * Local (non-MCP) tools, spec §6.3. Only `propose_menu` exists so far — `ensure_cart_context`
 * (Phase 4) and `record_resolution`/`finish_with_checkout` (Phase 5) land later. `state` is
 * mutated in place; the caller (runAgentTurn) persists it and reads `state.stage` afterwards.
 */
export function localTools(userId: number, state: SessionState): Record<string, Tool> {
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
  };
}
