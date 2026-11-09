import { describe, expect, test } from 'bun:test';
import { aDatabaseThatMustNotBeTouched } from '../../testing/doubles';
import { noNoticeWords, noPushNotices } from './notices';

describe('the notices of a process that runs no chat', () => {
  test('are none, and the database is not asked', async () => {
    expect(
      await noPushNotices.of(aDatabaseThatMustNotBeTouched(), 'a-message', ['a-person']),
    ).toEqual([]);
    expect(
      await noPushNotices.canDeliver(aDatabaseThatMustNotBeTouched(), 'a-message', 'a-person'),
    ).toBe(false);
  });
});

describe('the words of a process that runs no module with a notice a device is told of', () => {
  test('are none, in either language', () => {
    expect(noNoticeWords('issue_assigned', 'en', 'Ada')).toBeUndefined();
    expect(noNoticeWords('issue_assigned', 'tr', 'Ada')).toBeUndefined();
  });
});
