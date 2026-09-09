/**
 * The trap this guards against: TypeBox rejects **every** value for a format it
 * does not know. If `formats.ts` stops being imported, the contract does not
 * loosen — it refuses everything, and does so quietly.
 */
import { describe, expect, test } from 'bun:test';
import { FormatRegistry } from '@sinclair/typebox';
import { REGISTERED_FORMATS } from './formats';

describe('string formats', () => {
  for (const format of REGISTERED_FORMATS) {
    test(`\`${format}\` is registered`, () => {
      expect(FormatRegistry.Has(format)).toBe(true);
    });
  }

  test('uuid accepts a v7 and refuses a near miss', () => {
    const check = FormatRegistry.Get('uuid');
    expect(check?.('0199155c-6200-7b7f-8c11-2a4d3f9e1b70')).toBe(true);
    expect(check?.('0199155c-6200-7b7f-8c11-2a4d3f9e1b7')).toBe(false);
    expect(check?.('')).toBe(false);
  });

  test('date-time insists on a zone', () => {
    const check = FormatRegistry.Get('date-time');
    expect(check?.('2026-09-09T08:00:00.000Z')).toBe(true);
    expect(check?.('2026-09-09T08:00:00')).toBe(false);
  });
});
