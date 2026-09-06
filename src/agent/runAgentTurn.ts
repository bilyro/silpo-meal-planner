import { generateText, stepCountIs } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { config } from '../config.js';
import { logger } from '../logger.js';
import * as repo from '../db/repo.js';
import { NeedsAuthError, SilpoMcpClient } from '../mcp/SilpoMcpClient.js';
import { localTools } from './localTools.js';
import { loadSession, saveSession, type SessionState } from './session.js';
import { SYSTEM_PROMPT } from './systemPrompt.js';

/** Prior messages replayed to the model each turn (spec §6.5 uses N=12). */
const HISTORY_TURNS = 12;

export interface AgentTurnResult {
  text: string;
  stage: SessionState['stage'];
  /** Carried out so the bot can render the menu from tool data rather than the model's prose. */
  menu?: SessionState['menu'];
}

/** spec §6.5: one function per user turn — loads session, runs the tool-calling loop, persists. */
export async function runAgentTurn(userId: number, userMessage: string): Promise<AgentTurnResult> {
  const state = await loadSession(userId);
  const mcp = new SilpoMcpClient(userId);

  // Single try/catch around connect() *and* generateText(): a connect() failure that is not
  // NeedsAuthError (network blip, Silpo 5xx, etc.) must still produce a friendly reply instead
  // of propagating out of runAgentTurn — bot.ts has no catch around this call, only a `finally`,
  // so an uncaught rejection here would leave the user's message unanswered.
  try {
    await mcp.connect();

    const history = await repo.getRecentMessages(userId, HISTORY_TURNS);
    const tools = { ...localTools(userId, state, mcp), ...(await mcp.toolsForAiSdk()) };
    const result = await generateText({
      model: anthropic(config.AGENT_MODEL),
      system: `${SYSTEM_PROMPT}\n\n<session_state>${JSON.stringify(state)}</session_state>`,
      messages: [...history, { role: 'user', content: userMessage }],
      tools,
      stopWhen: stepCountIs(config.MAX_TOOL_CALLS_PER_TURN),
    });

    // Local tools already mutate `state` and save it themselves; this covers any leftover
    // mutation (e.g. stage changes not yet persisted) so the DB always reflects the latest turn.
    await saveSession(userId, state);
    const text = result.text || 'Готово.';
    // Recorded only on success: a failed turn shouldn't leave a dangling user message with no
    // reply, or persist a generic error string as if the assistant had said something meaningful.
    await repo.appendMessages(userId, [
      { role: 'user', content: userMessage },
      { role: 'assistant', content: text },
    ]);
    return { text, stage: state.stage, menu: state.menu };
  } catch (err) {
    if (err instanceof NeedsAuthError) {
      state.stage = 'need_auth';
      await saveSession(userId, state);
      return {
        text: `Потрібно підʼєднати акаунт Сільпо: ${err.authorizationUrl.toString()}`,
        stage: state.stage,
      };
    }
    logger.error({ err, userId }, 'Agent turn failed');
    return { text: 'Сталася помилка під час обробки запиту. Спробуйте ще раз.', stage: state.stage };
  } finally {
    await mcp.close();
  }
}
