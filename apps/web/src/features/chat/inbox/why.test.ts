/**
 * What a notification says (D-106), for the kind a reminder adds: it names nobody, because the person asked
 * for it themselves.
 */
import { describe, expect, test } from 'bun:test';
import type { Notification } from '@purlay/types';
import { en } from '../../../i18n/catalogue/en';
import { tr } from '../../../i18n/catalogue/tr';
import { createTranslate } from '../../../i18n/translate';
import { whyOf } from './why';

const reminder = {
  id: 'n-1',
  type: 'reminder',
  message: { sender: { id: 'alice', displayName: 'Alice', username: 'alice', avatarUrl: null } },
  thread: null,
} as unknown as Notification;

describe('why a person was told', () => {
  test('a reminder says it is due, in each language, naming nobody', () => {
    expect(whyOf(createTranslate('en', en), reminder, undefined, 'me')).toBe(
      en['inbox.why.reminder'],
    );
    expect(whyOf(createTranslate('tr', tr), reminder, undefined, 'me')).toBe(
      tr['inbox.why.reminder'],
    );
  });
});
