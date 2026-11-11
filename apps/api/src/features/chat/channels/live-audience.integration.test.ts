/** Canonical current live authority, publication batches and late recipients use real SQL. */
import { afterAll, describe, expect, test } from 'bun:test';
import {
  closeIntegrationDatabase,
  cloneIntegrationDatabase,
  sql,
  withRollback,
  type Executor,
} from '@purlay/db';
import { messageId, type ServerFrame } from '@purlay/types';
import { aRoom } from '../../../testing/rooms';
import { liveChannelScope } from './live-history';
import { liveAudienceReader } from './live-audience';
import { readBuilt } from '../messages/reader';
import {
  LIVE_AUDIENCE_BATCH_MAX,
  readLiveChannelAudience,
  requireChannelById,
  type ChannelContext,
} from './guard';

afterAll(closeIntegrationDatabase);

const failureOf = async (pending: Promise<unknown>): Promise<unknown> =>
  await pending.then(
    () => undefined,
    (error: unknown) => error,
  );

const signal = (): AbortSignal => new AbortController().signal;
const publication = (context: ChannelContext): ServerFrame => ({
  event: 'TYPING',
  data: { channelId: context.channelId, userId: context.userId, ttlMs: 5_000 },
  ts: Date.now(),
});
const counterPublication = (context: ChannelContext): ServerFrame => ({
  event: 'CHANNEL_STATE',
  data: {
    channelId: context.channelId,
    state: { lastReadMessageId: null, unreadCount: 1, unreadMentionCount: 0 },
  },
  version: 1,
  ts: Date.now(),
});
const fixture = async (db: Executor): Promise<ChannelContext> => {
  const room = await aRoom(db, ['owner', 'guest']);
  const userId = room.members['guest']?.userId ?? '';
  await db
    .updateTable('workspace_members')
    .set({
      access_kind: 'guest',
      guest_since: new Date(Date.now() - 60_000),
      guest_modules: ['chat'],
    })
    .where('workspace_id', '=', room.workspaceId)
    .where('user_id', '=', userId)
    .execute();
  return await requireChannelById(db, userId, room.channelId);
};

describe('integration: current live guest audience', () => {
  test.each([
    'channel-grant',
    'membership',
    'chat-scope',
    'expiry',
    'suspended',
    'deleted-user',
    'deleted-channel',
    'deleted-workspace',
  ] as const)(
    'a captured scope cannot deliver after losing %s even without a control frame',
    async (kind) => {
      await withRollback(async (db) => {
        const context = await fixture(db);
        const scope = liveChannelScope()(db, context);

        const frame = publication(context);
        expect(await scope.accepts(frame, signal())).toBe(true);
        switch (kind) {
          case 'channel-grant':
            await db
              .deleteFrom('channel_members')
              .where('channel_id', '=', context.channelId)
              .where('user_id', '=', context.userId)
              .execute();
            break;
          case 'membership':
            await db
              .deleteFrom('workspace_members')
              .where('workspace_id', '=', context.workspaceId)
              .where('user_id', '=', context.userId)
              .execute();
            break;
          case 'chat-scope':
            await db
              .updateTable('workspace_members')
              .set({ guest_modules: ['other'] })
              .where('workspace_id', '=', context.workspaceId)
              .where('user_id', '=', context.userId)
              .execute();
            break;
          case 'expiry':
            await db
              .updateTable('workspace_members')
              .set({ guest_expires_at: new Date(Date.now() - 1_000) })
              .where('workspace_id', '=', context.workspaceId)
              .where('user_id', '=', context.userId)
              .execute();
            break;
          case 'suspended':
            await db
              .updateTable('users')
              .set({ suspended_at: new Date() })
              .where('id', '=', context.userId)
              .execute();
            break;
          case 'deleted-user':
            await db
              .updateTable('users')
              .set({ deleted_at: new Date() })
              .where('id', '=', context.userId)
              .execute();
            break;
          case 'deleted-channel':
            await db
              .updateTable('channels')
              .set({ deleted_at: new Date() })
              .where('id', '=', context.channelId)
              .execute();
            break;
          case 'deleted-workspace':
            await db
              .updateTable('workspaces')
              .set({ deleted_at: new Date() })
              .where('id', '=', context.workspaceId)
              .execute();
            break;
        }
        // Same object, after completion: a previous answer is never reusable authority.
        expect(await scope.accepts(frame, signal())).toBe('revoked');
      });
    },
  );

  test.each(['converted', 'extended', 'new-admission', 'new-channel-grant'] as const)(
    'a changed active %s policy resynchronizes instead of delivering or discarding pending sends',
    async (kind) => {
      await withRollback(async (db) => {
        const context = await fixture(db);
        if (kind === 'converted') {
          if (context.guest === undefined) throw new Error('Missing guest history');
          // A channel granted at the history floor keeps that same floor after conversion;
          // only the changed membership kind requires a new subscription in this case.
          await db
            .updateTable('channel_members')
            .set({ joined_at: new Date(context.guest.historySince) })
            .where('channel_id', '=', context.channelId)
            .where('user_id', '=', context.userId)
            .execute();
        }
        const scope = liveChannelScope()(db, context);

        switch (kind) {
          case 'converted':
            await db
              .updateTable('workspace_members')
              .set({
                access_kind: 'member',
                guest_since: null,
                guest_expires_at: null,
                guest_modules: null,
              })
              .where('workspace_id', '=', context.workspaceId)
              .where('user_id', '=', context.userId)
              .execute();
            break;
          case 'extended':
            await db
              .updateTable('workspace_members')
              .set({ guest_expires_at: new Date(Date.now() + 60_000) })
              .where('workspace_id', '=', context.workspaceId)
              .where('user_id', '=', context.userId)
              .execute();
            break;
          case 'new-admission':
            await db
              .updateTable('workspace_members')
              // The fixture must be active in the canonical DB clock, even if the host runs ahead.
              .set({ guest_since: sql<Date>`statement_timestamp()` })
              .where('workspace_id', '=', context.workspaceId)
              .where('user_id', '=', context.userId)
              .execute();
            break;
          case 'new-channel-grant':
            await db
              .updateTable('channel_members')
              .set({ joined_at: new Date() })
              .where('channel_id', '=', context.channelId)
              .where('user_id', '=', context.userId)
              .execute();
            break;
        }
        expect(await scope.accepts(publication(context), signal())).toBe('resync');
      });
    },
  );

  test('trusted source time allows a readable tombstone but refuses forged creation times and foreign messages', async () => {
    await withRollback(async (db) => {
      const context = await fixture(db);
      const scope = liveChannelScope()(db, context);
      if (context.guest === undefined) throw new Error('Missing guest policy');
      const floor = new Date(context.guest.historySince).getTime();
      const old = messageId(new Date(floor - 1_000));
      const current = messageId(new Date(floor + 1_000));
      const foreign = await fixture(db);
      const foreignId = messageId(new Date());
      await db
        .insertInto('messages')
        .values([
          {
            id: old,
            channel_id: context.channelId,
            workspace_id: context.workspaceId,
            sender_id: context.userId,
            content: 'before',
            created_at: new Date(floor - 1_000),
          },
          {
            id: current,
            channel_id: context.channelId,
            workspace_id: context.workspaceId,
            sender_id: context.userId,
            content: 'after',
            created_at: new Date(floor + 1_000),
          },
          {
            id: foreignId,
            channel_id: foreign.channelId,
            workspace_id: foreign.workspaceId,
            sender_id: foreign.userId,
            content: 'foreign',
            created_at: new Date(),
          },
        ])
        .execute();
      const built = await readBuilt(db, current);
      if (built === undefined) throw new Error('Missing message');
      for (const [id, allowed] of [
        [old, false],
        [current, true],
        [foreignId, false],
        [messageId(new Date()), false],
      ] as const) {
        expect(
          await scope.accepts(
            {
              event: 'MESSAGE_CREATED',
              data: { ...built, id, createdAt: new Date().toISOString() },
              ts: Date.now(),
            },
            signal(),
          ),
        ).toBe(allowed);
      }
      await db
        .updateTable('messages')
        .set({ deleted_at: new Date(), content: '' })
        .where('id', '=', current)
        .execute();
      expect(
        await scope.accepts(
          {
            event: 'MESSAGE_HIDDEN',
            data: {
              workspaceId: context.workspaceId,
              channelId: context.channelId,
              messageId: current,
              hiddenAt: new Date().toISOString(),
            },
            ts: Date.now(),
          },
          signal(),
        ),
      ).toBe(true);
      const read = liveAudienceReader();
      const frame = publication(context);
      const [here, elsewhere] = await Promise.all([
        read(db, context, frame, current, signal()),
        read(db, foreign, frame, current, signal()),
      ]);
      expect(here?.messageCreatedAt?.getTime()).toBe(floor + 1_000);
      expect(elsewhere?.userId).toBe(foreign.userId);
      expect(elsewhere?.messageCreatedAt === null).toBe(true);
    });
  });

  test('a mixed full-member and guest batch retains trusted message time for both recipients', async () => {
    await withRollback(async (db) => {
      const guest = await fixture(db);
      if (guest.guest === undefined) throw new Error('Missing guest scope');
      const owner = await db
        .selectFrom('workspace_members')
        .select('user_id')
        .where('workspace_id', '=', guest.workspaceId)
        .where('access_kind', '=', 'member')
        .executeTakeFirstOrThrow();
      const member = await requireChannelById(db, owner.user_id, guest.channelId);
      const createdAt = new Date(new Date(guest.guest.historySince).getTime() + 1_000);
      const id = messageId(createdAt);
      await db
        .insertInto('messages')
        .values({
          id,
          workspace_id: guest.workspaceId,
          channel_id: guest.channelId,
          sender_id: owner.user_id,
          content: 'A shared live publication',
          created_at: createdAt,
        })
        .execute();
      const read = liveAudienceReader();
      const frame = publication(member);
      const [full, restricted] = await Promise.all([
        read(db, member, frame, id, signal()),
        read(db, guest, frame, id, signal()),
      ]);
      expect(full?.accessKind).toBe('member');
      expect(restricted?.accessKind).toBe('guest');
      expect(full?.messageCreatedAt?.getTime()).toBe(createdAt.getTime());
      expect(restricted?.messageCreatedAt?.getTime()).toBe(createdAt.getTime());
    });
  });

  test('a captured full-member scope stays useful and requests reauthorization when current membership becomes restricted', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['owner', 'member']);
      const userId = room.members['member']?.userId ?? '';
      const context = await requireChannelById(db, userId, room.channelId);
      expect(context.guest === undefined).toBe(true);
      const projector = liveChannelScope();
      const scope = projector(db, context);
      expect(scope.expiresAt === null).toBe(true);
      const old = messageId(new Date(Date.now() - 120_000));
      await db
        .insertInto('messages')
        .values({
          id: old,
          workspace_id: context.workspaceId,
          channel_id: context.channelId,
          sender_id: userId,
          content: 'Full member readable old words',
          created_at: new Date(Date.now() - 120_000),
        })
        .execute();
      const frame: ServerFrame = {
        event: 'MESSAGE_REVISED',
        data: {
          channelId: context.channelId,
          messageId: old,
          parentId: null,
          content: 'Revision of old words',
          editedAt: null,
          deletedAt: null,
          mentions: [],
        },
        version: 1,
        ts: Date.now(),
      };
      expect(await scope.accepts(frame, signal())).toBe(true);
      await db
        .updateTable('workspace_members')
        .set({
          access_kind: 'guest',
          guest_since: sql<Date>`statement_timestamp()`,
          guest_modules: ['chat'],
        })
        .where('workspace_id', '=', context.workspaceId)
        .where('user_id', '=', userId)
        .execute();
      expect(await scope.accepts(frame, signal())).toBe('resync');
      const current = projector(db, await requireChannelById(db, userId, room.channelId));
      expect(await current.accepts(frame, signal())).toBe(false);
      const fresh = messageId(new Date());
      await db
        .insertInto('messages')
        .values({
          id: fresh,
          workspace_id: context.workspaceId,
          channel_id: context.channelId,
          sender_id: userId,
          content: 'Fresh allowed words',
          created_at: sql<Date>`statement_timestamp()`,
        })
        .execute();
      expect(
        await current.accepts({ ...frame, data: { ...frame.data, messageId: fresh } }, signal()),
      ).toBe(true);
    });
  });

  test('zero recipients do not query and an oversized direct batch is refused', async () => {
    await withRollback(async (db) => {
      const context = await fixture(db);
      let reads = 0;
      const counted = db.withPlugin({
        transformQuery: (args) => args.node,
        transformResult: (args) => {
          reads++;
          return Promise.resolve(args.result);
        },
      });
      expect(await readLiveChannelAudience(counted, context, [], undefined)).toEqual([]);
      expect(
        await failureOf(
          readLiveChannelAudience(
            counted,
            context,
            Array.from({ length: LIVE_AUDIENCE_BATCH_MAX + 1 }, () => context.userId),
            undefined,
          ),
        ),
      ).toBeInstanceOf(RangeError);
      expect(reads).toBe(0);
    });
  });

  test('pending counters keep each channel history separate for a guest in both channels', async () => {
    await withRollback(async (db) => {
      const first = await fixture(db);
      const channel = await db
        .insertInto('channels')
        .values({ workspace_id: first.workspaceId, name: 'later-grant', type: 'private' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('channel_members')
        .values({
          channel_id: channel.id,
          user_id: first.userId,
          joined_at: new Date(Date.now() - 10_000),
        })
        .execute();
      const second = await requireChannelById(db, first.userId, channel.id);
      expect(first.guest?.historySince === second.guest?.historySince).toBe(false);
      let reads = 0;
      const counted = db.withPlugin({
        transformQuery: (args) => args.node,
        transformResult: (args) => {
          reads++;
          return Promise.resolve(args.result);
        },
      });
      const project = liveChannelScope();
      expect(
        await Promise.all(
          [first, second].map((context) =>
            project(counted, context).accepts(counterPublication(context), signal()),
          ),
        ),
      ).toEqual([true, true]);
      expect(reads).toBe(2);
    });
  });

  test('shared publications and distinct recipient counters use bounded batches with user-specific answers', async () => {
    await withRollback(async (db) => {
      const context = await fixture(db);
      const suffix = crypto.randomUUID().slice(0, 8);
      const people = await db
        .insertInto('users')
        .values(
          Array.from({ length: 1_001 }, (_, index) => ({
            username: `live-${suffix}-${String(index)}`,
            email: `live-${suffix}-${String(index)}@example.test`,
            display_name: 'Live guest',
          })),
        )
        .returning('id')
        .execute();
      await db
        .insertInto('workspace_members')
        .values(
          people.map(({ id }, index) => ({
            workspace_id: context.workspaceId,
            user_id: id,
            role: 'member' as const,
            ...(index % 2 === 0
              ? { access_kind: 'member' as const, guest_since: null, guest_modules: null }
              : {
                  access_kind: 'guest' as const,
                  guest_since: new Date(Date.now() - 30_000),
                  guest_modules: ['chat'],
                }),
          })),
        )
        .execute();
      await db
        .insertInto('channel_members')
        .values(
          people.map(({ id }) => ({
            channel_id: context.channelId,
            user_id: id,
            joined_at: new Date(Date.now() - 30_000),
          })),
        )
        .execute();
      const contexts = await Promise.all(
        people.map(async ({ id }) => await requireChannelById(db, id, context.channelId)),
      );
      const refused = contexts[1];
      if (refused === undefined) throw new Error('Missing refused recipient');
      await db
        .deleteFrom('channel_members')
        .where('channel_id', '=', refused.channelId)
        .where('user_id', '=', refused.userId)
        .execute();
      let reads = 0;
      const counted = db.withPlugin({
        transformQuery: (args) => args.node,
        transformResult: (args) => {
          reads++;
          return Promise.resolve(args.result);
        },
      });
      const read = liveAudienceReader();
      const frame = publication(context);
      const projector = liveChannelScope();
      const scopes = contexts.map((recipient) => projector(counted, recipient));
      expect(contexts.some((recipient) => recipient.guest === undefined)).toBe(true);
      expect(contexts.some((recipient) => recipient.guest !== undefined)).toBe(true);
      for (const size of [1, 10, 100, 500, 501, 1_001]) {
        reads = 0;
        const rows = await Promise.all(
          contexts
            .slice(0, size)
            .map(async (recipient) => await read(counted, recipient, frame, undefined, signal())),
        );
        expect(reads).toBe(Math.ceil(size / LIVE_AUDIENCE_BATCH_MAX));
        expect(rows.map((row) => row?.userId)).toEqual(
          contexts
            .slice(0, size)
            .map((recipient) =>
              recipient.userId === refused.userId ? undefined : recipient.userId,
            ),
        );
        reads = 0;
        const accepted = await Promise.all(
          scopes.slice(0, size).map((scope) => scope.accepts(frame, signal())),
        );
        expect(reads).toBe(Math.ceil(size / LIVE_AUDIENCE_BATCH_MAX));
        expect(accepted).toEqual(
          contexts
            .slice(0, size)
            .map((recipient) => (recipient.userId === refused.userId ? 'revoked' : true)),
        );
        reads = 0;
        const counters = await Promise.all(
          scopes
            .slice(0, size)
            .map((scope) => scope.accepts(counterPublication(context), signal())),
        );
        expect(reads).toBe(Math.ceil(size / LIVE_AUDIENCE_BATCH_MAX));
        expect(counters).toEqual(accepted);
      }
    });
  }, 30_000);

  test.each(['publication', 'counter'] as const)(
    '%s aborts and query failures never become allowed or cached, and executors stay separate',
    async (kind) => {
      await withRollback(async (db) => {
        const context = await fixture(db);
        let reads = 0;
        const counted = db.withPlugin({
          transformQuery: (args) => args.node,
          transformResult: (args) => {
            reads++;
            return Promise.resolve(args.result);
          },
        });
        const failure = new Error('Controlled unavailable authority');
        const unavailable = db.withPlugin({
          transformQuery: (args) => args.node,
          transformResult: () => Promise.reject(failure),
        });
        const read = liveAudienceReader();
        const frame = kind === 'counter' ? counterPublication(context) : publication(context);
        const aborted = new AbortController();
        aborted.abort(failure);
        expect(await failureOf(read(counted, context, frame, undefined, aborted.signal))).toBe(
          failure,
        );
        expect(reads).toBe(0);
        const results = await Promise.all([
          read(counted, context, frame, undefined, signal()),
          read(unavailable, context, frame, undefined, signal()).catch((error: unknown) => error),
        ]);
        expect(results[0]).toMatchObject({ userId: context.userId });
        expect(results[1]).toBe(failure);
        expect(reads).toBe(1);
        const cancelled = new AbortController();
        const afterRead = db.withPlugin({
          transformQuery: (args) => args.node,
          transformResult: (args) => {
            cancelled.abort(failure);
            return Promise.resolve(args.result);
          },
        });
        expect(await failureOf(read(afterRead, context, frame, undefined, cancelled.signal))).toBe(
          failure,
        );
        expect(await failureOf(read(unavailable, context, frame, undefined, signal()))).toBe(
          failure,
        );
      });
    },
  );

  test.each(['publication', 'counter'] as const)(
    'a %s recipient arriving after dispatch cannot join an old snapshot held across an independent revocation',
    async (kind) => {
      const cloned = await cloneIntegrationDatabase();
      try {
        const context = await fixture(cloned.db);
        const materialized = Promise.withResolvers<undefined>();
        const release = Promise.withResolvers<undefined>();
        let reads = 0;
        let constructions = 0;
        const held = cloned.db.withPlugin({
          transformQuery: (args) => {
            constructions++;
            return args.node;
          },
          transformResult: async (args) => {
            reads++;
            if (reads === 1) {
              materialized.resolve(undefined);
              await release.promise;
            }
            return args.result;
          },
        });
        const read = liveAudienceReader();
        const frame = kind === 'counter' ? counterPublication(context) : publication(context);
        const earlier = read(held, context, frame, undefined, signal());
        try {
          await materialized.promise;
          await cloned.db
            .deleteFrom('channel_members')
            .where('channel_id', '=', context.channelId)
            .where('user_id', '=', context.userId)
            .execute();
          const beforeLate = constructions;
          const pending = read(
            held,
            context,
            kind === 'counter' ? counterPublication(context) : frame,
            undefined,
            signal(),
          );
          // The next microtask dispatches a fresh batch. Construction is only a dispatch witness;
          // `reads` below separately counts real materialized SQL results.
          await new Promise<void>((resolve) => {
            queueMicrotask(resolve);
          });
          expect(constructions > beforeLate).toBe(true);
          const later = await pending;
          expect(later === undefined).toBe(true);
          expect(reads).toBe(2);
        } finally {
          release.resolve(undefined);
          await earlier;
        }
        expect(await earlier).toMatchObject({ userId: context.userId });
        expect((await read(held, context, frame, undefined, signal())) === undefined).toBe(true);
        expect(reads).toBe(3);
      } finally {
        await cloned.drop();
      }
    },
    30_000,
  );
});
