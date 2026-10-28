import { describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { NotificationQuery, NotificationType, NotificationTypesFilter } from './api';

const workspaceId = '0199155c-6200-7b7f-8c11-2a4d3f9e1b70';
const types = NotificationType.anyOf.map((type) => type.const);

/** Every nonempty ordered subset, including the longest legal wire value. */
const selections = (remaining: readonly string[], prefix: readonly string[] = []): string[] =>
  remaining.flatMap((type) => {
    const chosen = [...prefix, type];
    return [
      chosen.join(','),
      ...selections(
        remaining.filter((other) => other !== type),
        chosen,
      ),
    ];
  });

describe('the notification type query on the wire', () => {
  test('is optional, and every ordered subset of the owned enum is accepted', () => {
    expect(Value.Check(NotificationQuery, { workspaceId })).toBe(true);
    expect(Value.Check(NotificationQuery, { workspaceId, unreadOnly: false })).toBe(true);
    for (const value of selections(types)) {
      expect(Value.Check(NotificationTypesFilter, value), value).toBe(true);
      expect(
        Value.Check(NotificationQuery, { workspaceId, types: value, unreadOnly: true }),
        value,
      ).toBe(true);
    }
  });

  test('a duplicated type is rejected wherever it occurs, including nonadjacent repetitions', () => {
    for (const value of selections(types)) {
      for (const type of value.split(',')) {
        for (const invalid of [`${type},${value}`, `${value},${type}`]) {
          expect(Value.Check(NotificationTypesFilter, invalid), invalid).toBe(false);
        }
      }
    }
  });

  test.each(
    [
      '',
      'all',
      'unknown',
      'Mention',
      'MENTION',
      'mention,unknown',
      ' mention',
      'mention ',
      'mention, thread_reply',
      ',mention',
      'mention,',
      'mention,,thread_reply',
      'mention\n',
      'mention\r\n',
      'mention\t',
      'mention\u0000',
      'mention\u2028',
      'mentionx',
      'xmention',
      'mention;thread_reply',
      'mention|thread_reply',
      'mention,mention,mention,mention,mention,mention',
      ['mention'],
      ['thread_reply', 'thread_resolved'],
      null,
      1,
      true,
    ].map((types) => ({ types })),
  )('rejects %j rather than normalizing it', ({ types }) => {
    expect(Value.Check(NotificationQuery, { workspaceId, types })).toBe(false);
  });

  test('is a bounded JSON Schema string usable by a generator without a new custom format', () => {
    expect(NotificationTypesFilter.type).toBe('string');
    expect(NotificationTypesFilter.format).toBeUndefined();
    const pattern = new RegExp(NotificationTypesFilter.pattern ?? '');
    expect(pattern.test('thread_reply,thread_resolved')).toBe(true);
    expect(pattern.test('mention\n')).toBe(false);
    expect(pattern.test('mention,thread_reply,mention')).toBe(false);
    expect(NotificationTypesFilter.maxLength).toBe(types.join(',').length);
  });
});
