import { generateText, stepCountIs } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { NeedsAuthError, SilpoMcpClient } from '../mcp/SilpoMcpClient.js';
import { localTools } from './localTools.js';
import { loadSession, saveSession, type SessionState } from './session.js';
import { SYSTEM_PROMPT } from './systemPrompt.js';

export interface AgentTurnResult {
  text: string;
  stage: SessionState['stage'];
}

/** spec §6.5: one function per user turn — loads session, runs the tool-calling loop, persists. */
export async function runAgentTurn(userId: number, userMessage: string): Promise<AgentTurnResult> {
  const state = await loadSession(userId);
  const mcp = new SilpoMcpClient(userId);

  try {
    await mcp.connect();
  } catch (err) {
    if (err instanceof NeedsAuthError) {
      state.stage = 'need_auth';
      await saveSession(userId, state);
      return {
        text: `Потрібно підʼєднати акаунт Сільпо: ${err.authorizationUrl.toString()}`,
        stage: state.stage,
      };
    }
    throw err;
  }

  try {
    const tools = { ...localTools(userId, state), ...(await mcp.toolsForAiSdk()) };
    const result = await generateText({
      model: anthropic(config.AGENT_MODEL),
      system: `${SYSTEM_PROMPT}\n\n<session_state>${JSON.stringify(state)}</session_state>`,
      messages: [{ role: 'user', content: userMessage }],
      tools,
      stopWhen: stepCountIs(config.MAX_TOOL_CALLS_PER_TURN),
    });

    // Local tools already mutate `state` and save it themselves; this covers any leftover
    // mutation (e.g. stage changes not yet persisted) so the DB always reflects the latest turn.
    await saveSession(userId, state);
    return { text: result.text || 'Готово.', stage: state.stage };
  } catch (err) {
    logger.error({ err, userId }, 'Agent turn failed');
    return { text: 'Сталася помилка під час обробки запиту. Спробуйте ще раз.', stage: state.stage };
  } finally {
    await mcp.close();
  }
}
