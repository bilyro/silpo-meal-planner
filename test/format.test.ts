import { describe, expect, it } from 'vitest';
import { escapeHtml, formatMenu, pluralDays } from '../src/bot/format.js';
import type { SessionState } from '../src/agent/session.js';

type Menu = NonNullable<SessionState['menu']>;

const meal = (day: number, dish: string): Menu[number] => ({
  day,
  dish,
  ingredients: [{ name: 'морква', qty: '2 шт' }],
});

describe('pluralDays', () => {
  it('follows Ukrainian plural rules', () => {
    expect(pluralDays(1)).toBe('день');
    expect(pluralDays(2)).toBe('дні');
    expect(pluralDays(4)).toBe('дні');
    expect(pluralDays(5)).toBe('днів');
    expect(pluralDays(11)).toBe('днів'); // teens are днів despite ending in 1
    expect(pluralDays(21)).toBe('день');
    expect(pluralDays(22)).toBe('дні');
  });
});

describe('formatMenu', () => {
  it('counts distinct days, not meal entries', () => {
    // A "lunch and dinner for tomorrow" request: two meals, both day 1 — previously rendered
    // as "Меню на 2 дні", which is what the user actually reported.
    const menu: Menu = [meal(1, 'Обід: Курка'), meal(1, 'Вечеря: Салат')];
    const out = formatMenu(menu);

    expect(out).toContain('Меню на 1 день');
    expect(out).not.toContain('Меню на 2');
    // The day heading appears once, with both meals under it.
    expect(out.match(/<b>День 1<\/b>/g)).toHaveLength(1);
    expect(out).toContain('Обід: Курка');
    expect(out).toContain('Вечеря: Салат');
  });

  it('groups multiple days and orders them ascending', () => {
    const menu: Menu = [meal(2, 'Друга страва'), meal(1, 'Перша страва'), meal(2, 'Друга вечеря')];
    const out = formatMenu(menu);

    expect(out).toContain('Меню на 2 дні');
    expect(out.indexOf('День 1')).toBeLessThan(out.indexOf('День 2'));
    expect(out.match(/<b>День 2<\/b>/g)).toHaveLength(1);
  });

  it('escapes HTML in dish and ingredient names so Telegram parse_mode cannot break', () => {
    const menu: Menu = [
      { day: 1, dish: 'Салат <script>', ingredients: [{ name: 'сіль & перець', qty: '1 & 2' }] },
    ];
    const out = formatMenu(menu);

    expect(out).toContain('Салат &lt;script&gt;');
    expect(out).toContain('сіль &amp; перець');
    expect(out).not.toContain('<script>');
  });
});

describe('escapeHtml', () => {
  it('escapes the three characters Telegram HTML mode cares about', () => {
    expect(escapeHtml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });
});
