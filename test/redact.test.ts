/**
 * The redaction applied to `docs/tool-call-log.md`, which is a submission artefact built from a
 * real account's call log. A miss here publishes someone's home address, so the interesting cases
 * are the shapes real Silpo arguments actually take — nested objects, arrays of products, and the
 * mixed address/non-address payload of silpo_create_shopping_cart.
 */

import { describe, expect, it } from 'vitest';
import { REDACTED, redact } from '../scripts/redact.js';

describe('redact', () => {
  it('blanks every address component of a real silpo_create_shopping_cart payload', () => {
    // Copied from an actual logged call (docs/tool-call-log.md), which is why `house` is a bare
    // number and the coordinates are strings rather than numbers.
    const args = {
      city: 'Київ',
      house: '30/1',
      street: 'вул. Прикладна',
      branchId: '1edb6b38-214b-66d6-a8e0-7f2fdd178564',
      latitude: '50.4501',
      longitude: '30.5234',
      timeslot: { start: '2026-09-06T12:00:00+00:00', end: '2026-09-06T13:30:00+00:00' },
      addressType: 'house',
      deliveryType: 'DeliveryHome',
    };

    expect(redact(args)).toEqual({
      city: 'Київ', // kept on purpose: a city alone identifies nobody and makes the branch readable
      house: REDACTED,
      street: REDACTED,
      branchId: '1edb6b38-214b-66d6-a8e0-7f2fdd178564',
      latitude: REDACTED,
      longitude: REDACTED,
      timeslot: { start: '2026-09-06T12:00:00+00:00', end: '2026-09-06T13:30:00+00:00' },
      addressType: 'house',
      deliveryType: 'DeliveryHome',
    });
  });

  it('leaves product queries untouched — they are the substance of the transcript', () => {
    const args = {
      products: ['куряче філе', 'рис', 'сир пармезан'],
      limit: 5,
      timeslotStart: '2026-09-07T06:00:00+00:00',
    };
    expect(redact(args)).toEqual(args);
  });

  it('reaches personal keys nested inside objects and arrays', () => {
    const args = {
      addresses: [{ street: 'вул. Прикладна', comment: 'код 1234', isDefault: true }],
      delivery: { recipient: { firstName: 'Роман', phone: '+380...' }, type: 'DeliveryHome' },
    };
    expect(redact(args)).toEqual({
      addresses: [{ street: REDACTED, comment: REDACTED, isDefault: true }],
      // `recipient` is itself a personal key, so the whole subtree goes rather than being walked.
      delivery: { recipient: REDACTED, type: 'DeliveryHome' },
    });
  });

  it('matches keys case-insensitively', () => {
    expect(redact({ Street: 'вул. Прикладна', LATITUDE: '50.45' })).toEqual({
      Street: REDACTED,
      LATITUDE: REDACTED,
    });
  });

  it('does not mutate the row it was handed', () => {
    // The caller passes `row.argsJson` straight from the database result; mutating it would be an
    // easy way to corrupt anything else reading the same object.
    const args = { street: 'вул. Прикладна' };
    redact(args);
    expect(args.street).toBe('вул. Прикладна');
  });

  it('passes through the empty arguments that most profile tools log', () => {
    expect(redact({})).toEqual({});
  });
});
