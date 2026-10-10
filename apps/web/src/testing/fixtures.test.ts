/** The shared fixtures are what the tests that use them assume: ids that order, shapes that validate. */
import { describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { Channel, MeResponse, Message, isMessageIdShape } from '@purlay/types';
import {
  ALICE,
  BOB,
  IDS,
  ME,
  WHEN,
  WORKSPACE,
  aChannel,
  aMessage,
  aSession,
  aUser,
  messageIdAt,
  someChannels,
} from './fixtures';

describe('the fixtures', () => {
  test('are shapes the contract accepts', () => {
    expect(Value.Check(MeResponse, aSession())).toBe(true);
    expect(Value.Check(Message, aMessage(1))).toBe(true);
    for (const channel of someChannels()) expect(Value.Check(Channel, channel)).toBe(true);
  });

  test("message ids are UUIDv7s that sort by their position, so a test's order is production's", () => {
    const ids = [3, 1, 2].map(messageIdAt);
    expect(ids.every(isMessageIdShape)).toBe(true);
    expect([...ids].sort()).toEqual([1, 2, 3].map(messageIdAt));
  });

  test('the cast is who the ids say it is', () => {
    expect([ME.id, ALICE.id, BOB.id]).toEqual([IDS.me, IDS.alice, IDS.bob]);
    expect(aUser('carol', IDS.me).displayName).toBe('Carol');
    expect(new Date(WHEN).toISOString()).toBe(WHEN);
    expect(aSession().memberships[0]?.workspace).toEqual(WORKSPACE);
  });

  test('one channel is public and not joined, for the screens that offer to join it', () => {
    const browse = someChannels().find((c) => c.id === IDS.browse);
    expect(browse?.state).toBeNull();
    expect(aChannel(IDS.dm, null).name).toBeNull();
  });
});
