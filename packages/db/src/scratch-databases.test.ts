import { describe, expect, test } from 'bun:test';
import {
  cloneDatabaseName,
  databaseNameFromUrl,
  integrationTemplateName,
  onDatabase,
  scratchDatabaseName,
} from './scratch-databases';

describe('scratch database identifiers', () => {
  test('clone names retain the throwaway CLI alphabet for every source name without changing ordinary names', () => {
    const nonce = '0123456789ab';
    expect(cloneDatabaseName('purlay', nonce)).toBe('purlay_0123456789ab');
    const sources = ['Görkem', 'GORKEM', 'a%20b', 'two words', '🏭'];
    const names = sources.map((source) => cloneDatabaseName(source, nonce));
    expect(new Set(names).size).toBe(sources.length);
    for (const [index, name] of names.entries()) {
      expect(name).toMatch(/^purlay_[0-9a-f]{12}$/);
      expect(name).toBe(cloneDatabaseName(sources[index] ?? '', nonce));
      expect(name === cloneDatabaseName(sources[index] ?? '', '0123456789ac')).toBe(false);
    }
  });
  test('short names, including exactly the byte bound, are unchanged', () => {
    for (const name of ['', 'purlay_test', 'a'.repeat(62), 'a'.repeat(63), 'ğ'.repeat(31) + 'a']) {
      expect(scratchDatabaseName(name)).toBe(name);
    }
  });

  test('overlong names are stable and idempotent, and suffixes past the old truncation point remain distinct', () => {
    const prefix = 'purlay_test_'.padEnd(63, 'x');
    const names = ['_ce', '_wa', '_un'].map((suffix) => scratchDatabaseName(prefix + suffix));
    expect(new Set(names).size).toBe(3);
    for (const [index, name] of names.entries()) {
      expect(Buffer.byteLength(name)).toBeLessThanOrEqual(63);
      expect(name).toMatch(/_[0-9a-f]{12}$/);
      expect(scratchDatabaseName(name)).toBe(name);
      expect(name).toBe(scratchDatabaseName(prefix + (['_ce', '_wa', '_un'][index] ?? '')));
    }
  });

  test('a prefix never splits a multibyte character or counts characters as bytes', () => {
    for (const name of [
      'ğ'.repeat(32),
      '🏭'.repeat(20),
      'a' + '🏭'.repeat(20),
      'e\u0301'.repeat(30),
    ]) {
      const bounded = scratchDatabaseName(name);
      expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(63);
      expect(bounded.includes('\uFFFD')).toBe(false);
      expect(Buffer.from(bounded).toString()).toBe(bounded);
      expect(name.startsWith(bounded.slice(0, -13))).toBe(true);
    }
  });

  test('a template uses the same final-name calculation as its cleanup', () => {
    expect(integrationTemplateName('purlay')).toBe('purlay_template');
    const parent = 'purlay_'.padEnd(63, 'x');
    expect(Buffer.byteLength(integrationTemplateName(parent))).toBeLessThanOrEqual(63);
    expect(integrationTemplateName(parent) === parent).toBe(false);
    expect(
      integrationTemplateName(parent) === integrationTemplateName(parent.slice(0, -1) + 'a'),
    ).toBe(false);
  });
});

test('a generated name round-trips through a connection URL without changing the server or its options', () => {
  const source = 'postgres://tester:example@127.0.0.1:5432/source?sslmode=require';
  for (const name of ['postgres', 'Görkem %20 / şube', 'two words', '🏭', 'quoted"; name']) {
    const actual = new URL(onDatabase(source, name));
    expect(databaseNameFromUrl(actual.toString())).toBe(name);
    expect(actual.host).toBe(new URL(source).host);
    expect(actual.username).toBe(new URL(source).username);
    expect(actual.password).toBe(new URL(source).password);
    expect(actual.search).toBe(new URL(source).search);
    expect(databaseNameFromUrl(source)).toBe('source');
  }
});
