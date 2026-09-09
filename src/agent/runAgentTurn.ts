import { generateText, stepCountIs, type Tool } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';
import { config } from '../config.js';
import { logger } from '../logger.js';
import * as repo from '../db/repo.js';
import { NeedsAuthError, SilpoMcpClient } from '../mcp/SilpoMcpClient.js';
import { RELINK_MESSAGE } from '../bot/messages.js';
import { localTools } from './localTools.js';
import { formatMemoryBlock, recallMemory } from './memory.js';
import { repeatLastPlanTool } from './plans.js';
import { loadSession, saveSession, type SessionState } from './session.js';
import { SYSTEM_PROMPT } from './systemPrompt.js';

/** Prior messages replayed to the model each turn (spec §6.5 uses N=12). */
const HISTORY_TURNS = 12;

/** Thrown by withDeadline() when a turn outlives config.TURN_TIMEOUT_MS. */
class TurnTimeoutError extends Error {}

/**
 * Runs `work` under a hard wall-clock deadline (spec §8 Phase 6 item 4).
 *
 * Two mechanisms, because neither is sufficient alone: the AbortSignal is passed to generateText
 * and on to each MCP call, so an over-long turn actually cancels its in-flight HTTP requests
 * instead of leaving them running against the real Silpo account — but the AI SDK only *hands* the
 * signal to tool execution, it cannot interrupt an `execute` that ignores it, so a hung tool would
 * still leave generateText pending forever. The race is what guarantees the user gets a reply.
 */
async function withDeadline<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TurnTimeoutError(`Agent turn exceeded ${ms} ms`));
    }, ms);
  });
  try {
    // Promise.race subscribes to both, so whichever loses cannot surface as an unhandled rejection.
    return await Promise.race([work(controller.signal), expiry]);
  } finally {
    clearTimeout(timer);
  }
}

export interface AgentTurnResult {
  text: string;
  stage: SessionState['stage'];
  /** Carried out so the bot can render the menu from tool data rather than the model's prose. */
  menu?: SessionState['menu'];
  /** Same reason, for the list-resolved stage: totals must come from record_resolution's maths. */
  resolvedItems?: SessionState['resolvedItems'];
  totals?: SessionState['totals'];
}

/**
 * True when a reply restates a menu in prose the way `propose_menu` skipping forces it to — see
 * `retryProposeMenuIfSkipped` below. Two signals, either one enough:
 *
 * - an explicit «День N» header — the original signal, for menus that name the day;
 * - at least two bulleted lines carrying a recipe quantity (a number immediately followed by a
 *   mass/volume/piece/spoon unit). Found live 2026-09-09: a single-day request can come back as
 *   "🥩 Вечеря: Яловичий стейк з овочами" straight into an ingredient list, with NO «День 1»
 *   anywhere — the first signal alone missed this and the turn wasn't retried.
 *
 * Currency (грн) is deliberately absent from the unit list. `finish_with_checkout` /
 * `record_resolution` can also produce a bulleted reply — "• Яловичина — 495 грн" — and that one
 * must NOT trigger a propose_menu retry: recipes are measured in mass/volume/count, receipts in
 * money, and that distinction is what keeps the two shapes apart without needing to know which
 * tool actually ran. The caller adds a second, independent guard for the same reason — see
 * `noToolCallsThisTurn` below.
 *
 * Nothing else this bot does produces either shape, so a false positive here just costs one
 * wasted corrective call, never a wrong one.
 */
export function looksLikeUnconfirmedMenu(text: string): boolean {
  if (/день\s*\d+/i.test(text)) return true;
  // The trailing negative lookahead does the job \b would, without \b's real bug: JS word
  // boundaries are defined via \w, which does not include Cyrillic letters, so a plain \b right
  // after «г» never matches and silently killed every candidate. But dropping the boundary
  // entirely reopens the currency hole this regex exists to close — "495 грн" would match on the
  // bare "г" prefix of "грн" with nothing after it to reject. The lookahead requires that no
  // letter (Cyrillic or Latin) immediately follows the matched unit, so "г" alone still matches
  // "300г" (followed by a line break) but not the "г" inside "грн" (followed by "р").
  //
  // «зубч\w*» has the SAME \w bug one level up: \w* can only extend a match through ASCII word
  // characters, so it matches zero extra letters before hitting the Cyrillic «и» in «зубчики» —
  // the lookahead then correctly sees a letter right after «зубч» and rejects the whole match,
  // silently dropping every bullet whose only quantity unit is a garlic-clove count. A Cyrillic
  // character class, not \w, is what actually extends through the inflected ending.
  const recipeQtyBullet =
    /^[•*-]\s*.+[—-]\s*[\d.,]+\s*(г|кг|мл|л|шт|ст\.?\s*л\.?|ч\.?\s*л\.?|щіпка|зубч[а-яіїєґ]*|пучок)(?![а-яіїєґА-ЯІЇЄҐa-zA-Z])/gim;
  return (text.match(recipeQtyBullet) ?? []).length >= 2;
}

/**
 * `propose_menu` sometimes gets skipped even though the model goes on to write the full menu in
 * prose instead — see the header comment on `SYSTEM_PROMPT` in systemPrompt.ts (originally
 * measured ~1-in-3; a live retest this session got ~1-in-6, still real). Because the confirm/edit
 * buttons only render when `propose_menu` sets `stage='menu_proposed'` (bot.ts), a skip means the
 * buttons the reply just told the user to press simply never appear.
 *
 * Detected here on the ground truth — whether any step of THIS turn actually called the tool —
 * rather than reading `state.stage`, which could already read `'menu_proposed'` from an earlier,
 * unrelated turn regardless of what just happened.
 *
 * Fixed with a forced follow-up call rather than a stronger prompt: prompting alone already fell
 * short of 100% reliability once this session (the cart-total hallucination needed a structural
 * fix after a prompt-only one measurably failed on retest), so this makes the property structural
 * instead of hoped-for. `toolChoice` forces the tool call; the follow-up is fed the model's OWN
 * just-written text and told to structure exactly that, not to invent anything new — the same
 * "code resolves it, the model only supplies inputs" shape as `add_extra_items`.
 */
async function retryProposeMenuIfSkipped(
  state: SessionState,
  history: { role: 'user' | 'assistant'; content: string }[],
  userMessage: string,
  draftText: string,
  proposeMenuTool: Tool,
  signal: AbortSignal,
): Promise<void> {
  await generateText({
    model: anthropic(config.AGENT_MODEL),
    system: SYSTEM_PROMPT,
    messages: [
      ...history,
      { role: 'user', content: userMessage },
      { role: 'assistant', content: draftText },
      {
        role: 'user',
        content:
          'Виклич propose_menu з ТОЧНО тим меню, яке ти щойно написав вище — ті самі страви, ' +
          'інгредієнти й кількості, без змін і без додавань.',
      },
    ],
    tools: { propose_menu: proposeMenuTool },
    toolChoice: { type: 'tool', toolName: 'propose_menu' },
    abortSignal: signal,
  });
  // propose_menu's own execute() (localTools.ts) sets state.stage/state.menu directly and is
  // awaited inside generateText, so by the time this resolves either it ran or it didn't — nothing
  // further to check here. The caller falls back to the original draft if it didn't.
}

/** spec §6.5: one function per user turn — loads session, runs the tool-calling loop, persists. */
export async function runAgentTurn(userId: number, userMessage: string): Promise<AgentTurnResult> {
  const state = await loadSession(userId);
  const mcp = new SilpoMcpClient(userId);

  // Single try/catch around connect() *and* generateText(): a connect() failure that is not
  // NeedsAuthError (network blip, Silpo 5xx, etc.) must still produce a friendly reply instead
  // of propagating out of runAgentTurn — bot.ts has no catch around this call, only a `finally`,
  // so an uncaught rejection here would leave the user's message unanswered. The deadline sits
  // *inside* that try for the same reason, and covers connect() too: an unreachable Silpo must
  // not hold the turn open either.
  try {
    return await withDeadline(config.TURN_TIMEOUT_MS, async (signal) => {
      await mcp.connect();

      const [history, memory] = await Promise.all([
        repo.getRecentMessages(userId, HISTORY_TURNS),
        recallMemory(userId),
      ]);

      // Durable memory rides in the system prompt rather than the message history: it must survive
      // past the 12-turn window, and it must not be something the model can "forget" by talking
      // long enough. It also sits AFTER the static prompt so the cacheable prefix stays stable.
      const memoryBlock = formatMemoryBlock(memory);

      const tools = {
        ...localTools(userId, state, mcp),
        ...repeatLastPlanTool(userId, state),
        ...(await mcp.toolsForAiSdk()),
      };
      const result = await generateText({
        model: anthropic(config.AGENT_MODEL),
        system:
          `${SYSTEM_PROMPT}\n\n<session_state>${JSON.stringify(state)}</session_state>` +
          (memoryBlock ? `\n\n${memoryBlock}` : ''),
        messages: [...history, { role: 'user', content: userMessage }],
        tools,
        stopWhen: stepCountIs(config.MAX_TOOL_CALLS_PER_TURN),
        abortSignal: signal,
      });

      // A 401 raised inside a model-issued tool call never reaches the catch below: the AI SDK
      // catches a throwing `execute` and turns it into a tool-error fed back to the model, which
      // then writes some apology of its own. So the flag is checked here, and its reply wins over
      // whatever the model produced — otherwise a user whose token expired mid-turn is told
      // something vague and is left with no way to re-link.
      if (mcp.needsAuth) throw mcp.needsAuth;

      const text = result.text || 'Готово.';
      const proposedThisTurn = result.steps.some((s) => s.toolCalls?.some((c) => c.toolName === 'propose_menu'));
      // `noToolCallsThisTurn` implies `!proposedThisTurn` (no calls means propose_menu wasn't one
      // of them) — kept as two named checks anyway, not merged, so this stays legible as guarding
      // two different risks: `proposedThisTurn` is the ground-truth pin from the mutation test that
      // caught a `state.stage`-based version giving a false pass; `noToolCallsThisTurn` guards the
      // broadened bullet-quantity signal in looksLikeUnconfirmedMenu against firing after an
      // UNRELATED tool call that also happens to produce a bulleted reply
      // (record_resolution/add_extra_items/finish_with_checkout can all read like a list). Every
      // real skip observed so far called NO tool at all that turn — the model just wrote text — so
      // requiring that here is evidence-backed, not a guess.
      const noToolCallsThisTurn = result.steps.every((s) => (s.toolCalls?.length ?? 0) === 0);
      // propose_menu is unconditionally part of localTools()'s return, so this is always defined
      // in practice — the check exists only to satisfy the index-signature type, not a real gap.
      const proposeMenuTool = tools.propose_menu;
      if (!proposedThisTurn && noToolCallsThisTurn && proposeMenuTool && looksLikeUnconfirmedMenu(text)) {
        try {
          await retryProposeMenuIfSkipped(state, history, userMessage, text, proposeMenuTool, signal);
        } catch (err) {
          // A failed correction must not fail the whole turn — the user still gets the original
          // (correct-but-unconfirmed) text, exactly the pre-fix behaviour, not an error message.
          logger.warn({ err, userId }, 'propose_menu retry failed; returning the original draft');
        }
      }

      // Local tools already mutate `state` and save it themselves; this covers any leftover
      // mutation (e.g. stage changes not yet persisted, including the retry above) so the DB
      // always reflects the latest turn.
      await saveSession(userId, state);
      // Recorded only on success: a failed turn shouldn't leave a dangling user message with no
      // reply, or persist a generic error string as if the assistant had said something meaningful.
      await repo.appendMessages(userId, [
        { role: 'user', content: userMessage },
        { role: 'assistant', content: text },
      ]);
      return { text, stage: state.stage, menu: state.menu, resolvedItems: state.resolvedItems, totals: state.totals };
    });
  } catch (err) {
    if (err instanceof TurnTimeoutError) {
      // Nothing is persisted for a timed-out turn beyond what local tools already saved for
      // themselves: half a plan recorded as if it were the assistant's answer would be worse than
      // no history at all, and the user is invited to retry rather than shown a stack trace.
      logger.warn({ userId, timeoutMs: config.TURN_TIMEOUT_MS }, 'Agent turn timed out');
      return {
        text: 'Це зайняло надто багато часу, і я не встиг завершити. Спробуйте ще раз або сформулюйте запит простіше.',
        stage: state.stage,
      };
    }
    if (err instanceof NeedsAuthError) {
      state.stage = 'need_auth';
      await saveSession(userId, state);
      return {
        // Telegram auto-links a bare URL, so this is tappable without a keyboard — which matters
        // because the caller renders this as plain text rather than through relinkReply().
        text: err.authorizationUrl
          ? `Потрібно підʼєднати акаунт Сільпо: ${err.authorizationUrl.toString()}`
          : RELINK_MESSAGE,
        stage: state.stage,
      };
    }
    logger.error({ err, userId }, 'Agent turn failed');
    return { text: 'Сталася помилка під час обробки запиту. Спробуйте ще раз.', stage: state.stage };
  } finally {
    await mcp.close();
  }
}
