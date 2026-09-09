/**
 * The trap this guards against: TypeBox rejects **every** value for a format it
 * does not know. If `formats.ts` stops being imported, the contract does not
 * loosen — it refuses everything, and does so quietly.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
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

/**
 * Every string format mentioned anywhere in the repository is registered.
 *
 * This trap caught two schemas in two different packages, weeks apart, so it
 * gets a check rather than a comment. Deliberately static: reading the source
 * covers packages that do not exist yet, and a schema in one package relying on
 * a registration performed in another is precisely how it happened the second
 * time.
 */
describe('formats used across the repository', () => {
  test('no source mentions a format the registry does not know', () => {
    const root = new URL('../../../', import.meta.url).pathname;
    const sources = new Bun.Glob('{apps,packages,scripts}/**/*.ts');
    const used = new Map<string, string>();

    for (const file of sources.scanSync({ cwd: root, onlyFiles: true })) {
      if (file.includes('node_modules') || file.endsWith('.test.ts')) continue;
      for (const match of readFileSync(`${root}${file}`, 'utf8').matchAll(
        /format:\s*'([a-z0-9-]+)'/g,
      )) {
        const format = match[1];
        if (format !== undefined) used.set(format, file);
      }
    }

    expect(used.size).toBeGreaterThan(0);
    for (const [format, file] of used) {
      // Reported as an object so a failure names the format and where it is used.
      expect({ format, file, registered: REGISTERED_FORMATS.includes(format as never) }).toEqual({
        format,
        file,
        registered: true,
      });
    }
  });
});
