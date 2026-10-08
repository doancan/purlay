/**
 * The test-user factory refuses a name with no room for its suffix — before it
 * reaches the database, where the same mistake would be a constraint violation
 * that names the column rather than the test.
 */
import { describe, expect, test } from 'bun:test';
import { aDatabaseThatMustNotBeTouched } from '../ingress/http/testing';
import { aUniqueSlug, aUserRow } from './users';

describe('test users', () => {
  test('a name too long for its suffix is refused before the database is reached', async () => {
    const refusal = await aUserRow(aDatabaseThatMustNotBeTouched(), 'x'.repeat(33)).then(
      () => 'accepted',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(refusal).toContain('too long');
  });

  test('two slugs for one name are never the same', () => {
    expect(aUniqueSlug('team')).not.toBe(aUniqueSlug('team'));
    expect(aUniqueSlug('team')).toMatch(/^team-[0-9a-f]{6}$/);
  });
});
