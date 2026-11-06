import { expect, test } from 'bun:test';
import { invitationRecipientFilterIn } from './invitation-recipient-filter';

test('shared invitation addresses restore valid filters without a stale cursor or unrelated inputs', () => {
  expect(
    invitationRecipientFilterIn('?q=%20Ann%40Example.test%20&status=failed&before=old&limit=1'),
  ).toEqual({ q: 'Ann@Example.test', status: 'failed' });
  expect(invitationRecipientFilterIn('?q=%20%20&status=joined')).toEqual({ status: 'joined' });
  expect(invitationRecipientFilterIn('?q=ann&status=delivered')).toEqual({ q: 'ann' });
  expect(invitationRecipientFilterIn(`?q=${'a'.repeat(255)}&status=delivered`)).toEqual({});
  expect(invitationRecipientFilterIn('')).toEqual({});
});
