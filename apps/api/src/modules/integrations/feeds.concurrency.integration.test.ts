/**
 * Two admins connecting at once (D-134): the channel's row is locked first, so they take turns. The
 * same repository twice is one feed and a `GITHUB_FEED_EXISTS`, never a constraint's `500`; two at the
 * last place under the cap are one feed and a `GITHUB_FEEDS_LIMIT`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  type ClonedDatabase,
} from '@purlay/db';
import { GITHUB_FEEDS_PER_CHANNEL_MAX } from '@purlay/types';
import type { ChannelContext } from '../../platform/channels';
import { fixedClock } from '../../platform/clock';
import { credentialCipher } from '../../platform/crypto';
import { AppError } from '../../platform/errors';
import { aRoom } from '../../testing/rooms';
import { createFeed } from './feeds';

const clock = fixedClock(new Date('2026-10-14T12:00:00.000Z'));
const cipher = credentialCipher(Buffer.alloc(32, 5).toString('base64'));

let cloned: ClonedDatabase;
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
});
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
});

const connect = async (context: ChannelContext, repository: string): Promise<string> =>
  await cloned.db
    .transaction()
    .execute(
      async (t) => await createFeed(t, clock, cipher, context, { repository, events: ['push'] }),
    )
    .then(
      () => 'connected',
      (error: unknown) => (error instanceof AppError ? error.body.code : String(error)),
    );

describe('integration: two connections at once', () => {
  test('the same repository twice: one feed, and the other is told it exists', async () => {
    const room = await aRoom(cloned.db, ['alice']);
    const alice = room.members['alice']?.context;
    if (alice === undefined) throw new Error('no alice');
    const outcomes = await Promise.all([connect(alice, 'acme/api'), connect(alice, 'Acme/API')]);
    expect(outcomes.sort()).toEqual(['GITHUB_FEED_EXISTS', 'connected']);
  });

  test('two at the last place under the cap: one feed, and the other is told it is full', async () => {
    const room = await aRoom(cloned.db, ['alice']);
    const alice = room.members['alice']?.context;
    if (alice === undefined) throw new Error('no alice');
    for (let n = 0; n < GITHUB_FEEDS_PER_CHANNEL_MAX - 1; n++) {
      expect(await connect(alice, `acme/r${String(n)}`)).toBe('connected');
    }
    const outcomes = await Promise.all([connect(alice, 'acme/one'), connect(alice, 'acme/two')]);
    expect(outcomes.sort()).toEqual(['GITHUB_FEEDS_LIMIT', 'connected']);
  });
});
