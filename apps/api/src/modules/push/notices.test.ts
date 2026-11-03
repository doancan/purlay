import { describe, expect, test } from 'bun:test';
import { aDatabaseThatMustNotBeTouched } from '../../testing/doubles';
import { noPushNotices } from './notices';

describe('the notices of a process that runs no chat', () => {
  test('are none, and the database is not asked', async () => {
    expect(
      await noPushNotices.of(aDatabaseThatMustNotBeTouched(), 'a-message', ['a-person']),
    ).toEqual([]);
  });
});
