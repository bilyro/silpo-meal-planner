/**
 * Regression for 7 Sept 2026: after a `/clear`, `ensureCartContext` kept an already-expired slot.
 *
 * Re-booking was gated solely on Silpo reporting a `timeslot` validation error, and an *empty*
 * cart reports no validations at all — so the stale slot survived and every 🔒 search ran against
 * it. «картопля» came back as «Картопляні зрази з капустою», three of six ingredients missed, and
 * the cart reported `product.offer.status.not_available`. It read like a bad search heuristic; the
 * cause was upstream.
 */

import { describe, expect, it, vi } from 'vitest';

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
  },
}));

vi.mock('../src/logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), trace: vi.fn() },
}));

import { hasTimeslotError, isTimeslotExpired } from '../src/agent/cartContext.js';

const NOW = Date.parse('2026-09-07T07:32:00Z');
const at = (iso: string) => ({ start: '2026-09-07T06:00:00+00:00', end: iso });

describe('isTimeslotExpired', () => {
  it('flags the slot that actually caused the incident', () => {
    // Ended 07:30; the run started at 07:32 and Silpo reported nothing, because the cart was empty.
    expect(isTimeslotExpired(at('2026-09-07T07:30:00+00:00'), NOW)).toBe(true);
  });

  it('flags a slot about to end mid-run', () => {
    // Resolving takes several batched searches; a slot with two minutes left is already useless.
    expect(isTimeslotExpired(at('2026-09-07T07:34:00+00:00'), NOW)).toBe(true);
  });

  it('leaves a slot with real time left alone', () => {
    expect(isTimeslotExpired(at('2026-09-07T09:00:00+00:00'), NOW)).toBe(false);
  });

  it('does not flag a slot ending exactly at the margin boundary plus a second', () => {
    expect(isTimeslotExpired(at('2026-09-07T07:37:01+00:00'), NOW)).toBe(false);
  });

  it('defers to hasTimeslotError when there is no parseable slot', () => {
    // Returning true here would re-book on every cart that simply has not booked a slot yet.
    expect(isTimeslotExpired(undefined, NOW)).toBe(false);
    expect(isTimeslotExpired({ start: 'x', end: 'not-a-date' }, NOW)).toBe(false);
    expect(isTimeslotExpired({ start: '2026-09-07T06:00:00Z' }, NOW)).toBe(false);
  });
});

describe('hasTimeslotError', () => {
  it('still catches the case it was written for', () => {
    const cart = { calculation: { validations: [{ level: 'error', type: 'timeslot', message: 'timeslot.not_found' }] } };
    expect(hasTimeslotError(cart)).toBe(true);
  });

  it('reports nothing for an empty cart — which is exactly why the clock check exists', () => {
    expect(hasTimeslotError({})).toBe(false);
    expect(hasTimeslotError({ calculation: { validations: [] } })).toBe(false);
  });

  it('ignores non-timeslot and non-error validations', () => {
    const cart = {
      calculation: {
        validations: [
          { level: 'error', type: 'order', message: 'order.cost.min' },
          { level: 'warning', type: 'timeslot', message: 'expiring soon' },
        ],
      },
    };
    expect(hasTimeslotError(cart)).toBe(false);
  });
});
