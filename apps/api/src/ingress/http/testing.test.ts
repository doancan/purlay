/**
 * The doubles a test leans on, tested themselves.
 *
 * `/health` proves it is liveness by being handed a database that throws when
 * touched. If the double did not throw, that test would pass for the wrong
 * reason, and so would every other test that relies on it (`CONTRIBUTING.md` §6.4).
 */
import { describe, expect, test } from 'bun:test';
import { aDatabaseThatMustNotBeTouched } from './testing';

describe('a database that must not be touched', () => {
  test('refuses any use at all, naming what was reached for', () => {
    const database = aDatabaseThatMustNotBeTouched();
    expect(() => database.selectFrom('users')).toThrow(/selectFrom/);
    expect(() => database.transaction()).toThrow(/transaction/);
  });
});
