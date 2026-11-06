import { expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { InvitationRecipientQuery, InvitationRecipientStatus } from './api';

test('recipient filters share the bounded cursor contract and refuse unknown states and fields', () => {
  expect(Value.Check(InvitationRecipientQuery, {})).toBe(true);
  for (const status of InvitationRecipientStatus.anyOf) {
    expect(
      Value.Check(InvitationRecipientQuery, {
        q: 'Ann@Example.test',
        status: status.const,
        limit: 1,
      }),
    ).toBe(true);
  }
  for (const input of [
    { status: 'delivered' },
    { q: 'a'.repeat(255) },
    { before: 'invalid' },
    { limit: 0 },
    { limit: 101 },
    { offset: 1 },
    { email: 'private@example.test' },
  ]) {
    expect(Value.Check(InvitationRecipientQuery, input)).toBe(false);
  }
});
