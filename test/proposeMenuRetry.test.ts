/**
 * `propose_menu` sometimes gets skipped even though the model goes on to write the full menu in
 * prose instead of calling the tool — the confirm/edit buttons only render when the tool sets
 * `stage='menu_proposed'` (bot.ts), so a skip means the buttons the reply just told the user to
 * press never appear. Reproduced live this session: 2 of 12 identical live retries against a real
 * account skipped the tool while writing a correct menu in text.
 *
 * `runAgentTurn.ts` now detects this on the ground truth (did any step of THIS turn actually call
 * the tool, not `state.stage`, which could already read `menu_proposed` from an unrelated earlier
 * turn) and forces a corrective follow-up call with `toolChoice` rather than hoping a stronger
 * prompt fixes it — a prompt-only fix already failed to reach 100% reliability once this session.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config.js', () => ({
  config: {
    TELEGRAM_BOT_TOKEN: 'test',
    ANTHROPIC_API_KEY: 'test',
    PUBLIC_BASE_URL: 'https://example.invalid',
    SILPO_MCP_URL: 'https://example.invalid/mcp',
    DATABASE_URL: 'postgres://test',
    LOG_LEVEL: 'silent',
    MAX_TOOL_CALLS_PER_TURN: 25,
    TURN_TIMEOUT_MS: 60_000,
    PORT: 3000,
    AGENT_MODEL: 'test-model',
    DAILY_MESSAGE_LIMIT: 8,
  },
}));

vi.mock('../src/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

vi.mock('../src/db/repo.js', () => ({
  logToolCall: vi.fn(async () => {}),
  getRecentMessages: vi.fn(async () => []),
  appendMessages: vi.fn(async () => {}),
  getSessionState: vi.fn(async () => undefined),
  saveSessionState: vi.fn(async () => {}),
  listUserFacts: vi.fn(async () => []),
  listRecentPlans: vi.fn(async () => []),
  countUserMessagesToday: vi.fn(async () => 0),
}));

vi.mock('@ai-sdk/anthropic', () => ({ anthropic: vi.fn(() => ({ modelId: 'test-model' })) }));

// Only generateText is replaced — `tool`/`jsonSchema` are real, so propose_menu's actual execute()
// runs for real inside the mock, exactly as it would in production.
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: vi.fn(),
}));

import { generateText, type Tool } from 'ai';
import * as repo from '../src/db/repo.js';
import { runAgentTurn } from '../src/agent/runAgentTurn.js';
import { looksLikeUnconfirmedMenu } from '../src/agent/runAgentTurn.js';
import { SilpoMcpClient } from '../src/mcp/SilpoMcpClient.js';

const generateTextMock = vi.mocked(generateText);

const DRAFT_TEXT =
  '**День 1: Обід — Борщ**\n• Буряк — 3 шт\n\n**День 1: Вечеря — Тушена яловина**\n• Яловина — 800 г';

const DISHES = [
  { day: 1, dish: 'Борщ', ingredients: [{ name: 'буряк', qty: '3 шт' }] },
  { day: 1, dish: 'Тушена яловина', ingredients: [{ name: 'яловина', qty: '800 г' }] },
];

function stubMcp() {
  vi.spyOn(SilpoMcpClient.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(SilpoMcpClient.prototype, 'toolsForAiSdk').mockResolvedValue({});
  vi.spyOn(SilpoMcpClient.prototype, 'close').mockResolvedValue(undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  stubMcp();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('looksLikeUnconfirmedMenu', () => {
  it('matches the model\'s own restated-menu shape', () => {
    expect(looksLikeUnconfirmedMenu('**День 1: Обід — Борщ**')).toBe(true);
    expect(looksLikeUnconfirmedMenu('День 2: Вечеря')).toBe(true);
  });

  it('does not match ordinary replies', () => {
    expect(looksLikeUnconfirmedMenu('Дякую! Гарного дня 😊')).toBe(false);
    expect(looksLikeUnconfirmedMenu('Напишіть адресу доставки.')).toBe(false);
  });

  it('matches a single-day menu with NO «День N» label at all', () => {
    // Live regression (2026-09-09): this exact reply skipped propose_menu and the original
    // «день\d+» signal alone missed it — nothing here names a day.
    const text =
      '🥩 <b>Вечеря: Яловичий стейк з овочами</b>\n' +
      '• <i>Яловичий стейк</i> — 300г\n' +
      '• <i>Морква</i> — 150г\n' +
      '• <i>Картопля</i> — 300г\n' +
      '• <i>Цибуля</i> — 50г\n' +
      '• <i>Оливкова олія</i> — 2 ст. л.\n' +
      '• <i>Сіль і перець</i> — за смаком\n' +
      'Приймаєш це меню?';
    expect(looksLikeUnconfirmedMenu(text)).toBe(true);
  });

  it('matches a single-day menu whose only quantity unit is «зубчики» (garlic cloves)', () => {
    // \w in JS regex does not include Cyrillic, so «зубч\w*» matched zero extra letters before
    // hitting the «и» in «зубчики» and the trailing negative lookahead then rejected the whole
    // bullet — a real recipe whose only units are clove counts never reached the >=2 threshold.
    const text =
      '🧄 <b>Вечеря: Часникова паста</b>\n' +
      '• <i>Часник</i> — 3 зубчики\n' +
      '• <i>Олія</i> — 2 ст. л.\n' +
      'Приймаєш це меню?';
    expect(looksLikeUnconfirmedMenu(text)).toBe(true);
  });

  it('does not match a single bulleted line — needs at least two to avoid an incidental hit', () => {
    expect(looksLikeUnconfirmedMenu('До речі — • Одна нотатка — 5 хвилин почекайте.')).toBe(false);
  });

  it('does not match a resolved-items PRICE summary, even though it is also bulleted', () => {
    // record_resolution / finish_with_checkout can produce this exact shape. Recipes are measured
    // in mass/volume/count; receipts are measured in money — грн is deliberately not a unit here.
    const text = '✅ Меню готове!\n• Яловичина — 495 грн\n• Картопля — 120 грн\n• Морква — 60 грн';
    expect(looksLikeUnconfirmedMenu(text)).toBe(false);
  });
});

describe('propose_menu retry', () => {
  it('forces the tool call and recovers when the tool was skipped', async () => {
    let call = 0;
    generateTextMock.mockImplementation(async (options: unknown) => {
      call += 1;
      if (call === 1) {
        return { text: DRAFT_TEXT, steps: [{ toolCalls: [] }] } as never;
      }
      // The retry: forced tool choice, and the real propose_menu tool actually runs.
      const opts = options as { toolChoice?: unknown; tools?: Record<string, Tool> };
      expect(opts.toolChoice).toEqual({ type: 'tool', toolName: 'propose_menu' });
      const proposeMenu = opts.tools?.propose_menu as unknown as {
        execute: (input: unknown) => Promise<unknown>;
      };
      await proposeMenu.execute({ days: 1, dishes: DISHES });
      return {
        text: '',
        steps: [{ toolCalls: [{ toolName: 'propose_menu', input: { days: 1, dishes: DISHES } }] }],
      } as never;
    });

    const result = await runAgentTurn(42, 'Збери меню на весь день обід борщ. Вечеря яловичина');

    expect(generateTextMock).toHaveBeenCalledTimes(2);
    expect(result.stage).toBe('menu_proposed');
    expect(result.menu).toEqual(DISHES);
    // The persisted/returned text stays the model's own (already-correct) draft — only the
    // missing tool call gets corrected, not the wording the user already saw described.
    expect(result.text).toBe(DRAFT_TEXT);
  });

  it('does not retry when propose_menu was already called this turn', async () => {
    generateTextMock.mockResolvedValue({
      text: DRAFT_TEXT,
      steps: [{ toolCalls: [{ toolName: 'propose_menu', input: { days: 1, dishes: DISHES } }] }],
    } as never);

    await runAgentTurn(42, 'Збери меню на весь день обід борщ. Вечеря яловичина');

    // Text matches the menu pattern here too — the retry must key off the ACTUAL tool call this
    // turn, not the text shape alone, or a turn that already succeeded would be retried for free.
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry when a DIFFERENT tool ran, even if the reply happens to read like a menu', async () => {
    // record_resolution genuinely produces mass/volume-quantified bullets too ("• Яловичина —
    // 800 г"), so the currency exclusion alone wouldn't catch this case — noToolCallsThisTurn is
    // the guard that does.
    generateTextMock.mockResolvedValue({
      text: '✅ Підібрав!\n• Яловичина — 800 г\n• Картопля — 600 г',
      steps: [{ toolCalls: [{ toolName: 'record_resolution', input: {} }] }],
    } as never);

    await runAgentTurn(42, 'Так, підходить');

    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a reply that is not a menu', async () => {
    generateTextMock.mockResolvedValue({ text: 'Будь ласка! 😊', steps: [{ toolCalls: [] }] } as never);

    const result = await runAgentTurn(42, 'Дякую!');

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('Будь ласка! 😊');
  });

  it('falls back to the original draft, without failing the turn, if the retry itself throws', async () => {
    let call = 0;
    generateTextMock.mockImplementation(async () => {
      call += 1;
      if (call === 1) return { text: DRAFT_TEXT, steps: [{ toolCalls: [] }] } as never;
      throw new Error('network blip');
    });

    const result = await runAgentTurn(42, 'Збери меню на весь день обід борщ. Вечеря яловичина');

    expect(generateTextMock).toHaveBeenCalledTimes(2);
    // Exactly the pre-fix behaviour: the correct-but-unconfirmed draft, not an error message and
    // not a crashed turn.
    expect(result.text).toBe(DRAFT_TEXT);
    expect(result.stage).not.toBe('menu_proposed');
    expect(repo.appendMessages).toHaveBeenCalledTimes(1);
  });
});
