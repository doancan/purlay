/** Real source visibility, workspace caches and bounded/coalesced origin work. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../../platform/clock';
import { aRecordingLogger } from '../../../testing/doubles';
import { aRoom, type Room } from '../../../testing/rooms';
import { requireMessageById, type VisibleMessage } from '../channels/guard';
import { removeMessage } from '../messages/delete';
import type { ExternalFetch } from '../../../modules/images/proxy';
import { externalPageFetch, webPreviews } from './web-previews';

afterAll(async () => {
  await closeIntegrationDatabase();
});
const NOW = new Date('2026-11-07T12:00:00.000Z');
describe('integration: public web previews', () => {
  test('integration: the production metadata transport refuses the system resolver’s loopback answer before connecting', async () => {
    expect(await externalPageFetch(new URL('https://localhost/'))).toEqual({
      kind: 'failed',
      reason: 'refused an address that is not public',
    });
  });
  const URL_A = 'https://docs.example/report';
  const URL_B = 'https://news.example/article';
  const CARD = { title: 'Report', description: null, imageUrl: null };
  const html = (title = 'Report'): Uint8Array =>
    new TextEncoder().encode(`<title>${title}</title>`);
  let written = 0;

  const say = async (
    db: Executor,
    room: Room,
    senderId: string,
    content: string,
  ): Promise<string> => {
    written += 1;
    const id = messageId(new Date(NOW.getTime() + written));
    await db
      .insertInto('messages')
      .values({
        id,
        workspace_id: room.workspaceId,
        channel_id: room.channelId,
        sender_id: senderId,
        content,
        created_at: NOW,
      })
      .execute();
    return id;
  };
  interface Seed {
    readonly room: Room;
    readonly author: Room['members'][string];
    readonly reader: Room['members'][string];
    readonly id: string;
    readonly visible: VisibleMessage;
  }
  const seed = async (db: Executor, content = URL_A): Promise<Seed> => {
    const room = await aRoom(db, ['alice', 'bob']);
    const author = room.members['alice'];
    const reader = room.members['bob'];
    if (author === undefined || reader === undefined) throw new Error('Missing fixture people');
    const id = await say(db, room, author.userId, content);
    return { room, author, reader, id, visible: await requireMessageById(db, reader.userId, id) };
  };
  const make = (database: Executor, fetch: ExternalFetch): ReturnType<typeof webPreviews> =>
    webPreviews({
      database,
      fetch,
      clock: fixedClock(NOW),
      log: aRecordingLogger().log,
      appUrl: 'https://purlay.test',
    });

  test('integration: caches a document once across fragment links, without moving a receipt or follow choice', async () => {
    await withRollback(async (db) => {
      const f = await seed(db, `${URL_A}#one`);
      const second = await say(db, f.room, f.author.userId, `${URL_A}#two`);
      await say(db, f.room, f.author.userId, 'Another unread message');
      await db
        .updateTable('channel_members')
        .set({ unread_count: 3, unread_mention_count: 1 })
        .where('channel_id', '=', f.room.channelId)
        .where('user_id', '=', f.reader.userId)
        .execute();
      await db
        .insertInto('thread_follows')
        .values({
          user_id: f.reader.userId,
          message_id: f.id,
          workspace_id: f.room.workspaceId,
          channel_id: f.room.channelId,
          following: false,
        })
        .execute();
      const before = await db
        .selectFrom('channel_members')
        .selectAll()
        .where('channel_id', '=', f.room.channelId)
        .where('user_id', '=', f.reader.userId)
        .executeTakeFirstOrThrow();
      const asked: string[] = [];
      const read = make(db, (url) => {
        asked.push(url.href);
        return Promise.resolve({ kind: 'bytes', bytes: html() });
      });
      expect(await read(f.visible, `${URL_A}#one`)).toEqual(CARD);
      expect(
        await read(await requireMessageById(db, f.reader.userId, second), `${URL_A}#two`),
      ).toEqual(CARD);
      expect(asked).toEqual([URL_A]);
      expect(
        await db.selectFrom('link_previews').selectAll().where('url', '=', URL_A).execute(),
      ).toHaveLength(1);
      expect(
        await db
          .selectFrom('channel_members')
          .selectAll()
          .where('channel_id', '=', f.room.channelId)
          .where('user_id', '=', f.reader.userId)
          .executeTakeFirstOrThrow(),
      ).toEqual(before);
      expect(
        (
          await db
            .selectFrom('thread_follows')
            .select('following')
            .where('message_id', '=', f.id)
            .where('user_id', '=', f.reader.userId)
            .executeTakeFirstOrThrow()
        ).following,
      ).toBe(false);
    });
  });

  test('integration: a workspace never borrows another workspace’s cached metadata', async () => {
    await withRollback(async (db) => {
      const a = await seed(db);
      const b = await seed(db);
      let calls = 0;
      const read = make(db, () => {
        calls += 1;
        return Promise.resolve({ kind: 'bytes', bytes: html(`Report ${String(calls)}`) });
      });
      expect((await read(a.visible, URL_A))?.title).toBe('Report 1');
      expect((await read(b.visible, URL_A))?.title).toBe('Report 2');
      expect((await read(a.visible, URL_A))?.title).toBe('Report 1');
      expect(calls).toBe(2);
    });
  });

  test('integration: positive metadata expires at five minutes and a negative answer at one, without logging a secret URL', async () => {
    await withRollback(async (db) => {
      const privateUrl = `${URL_B}?private-note=never-log-this`;
      const f = await seed(db, `${URL_A}\n${privateUrl}`);
      let now = NOW.getTime();
      let calls = 0;
      let available = true;
      const recorded = aRecordingLogger();
      const read = webPreviews({
        database: db,
        appUrl: 'https://purlay.test',
        clock: { now: () => new Date(now) },
        log: recorded.log,
        fetch: () => {
          calls += 1;
          return Promise.resolve(
            available ? { kind: 'bytes', bytes: html() } : { kind: 'failed', reason: privateUrl },
          );
        },
      });
      expect(await read(f.visible, URL_A)).toEqual(CARD);
      now += 299_999;
      await read(f.visible, URL_A);
      expect(calls).toBe(1);
      now += 1;
      await read(f.visible, URL_A);
      expect(calls).toBe(2);
      available = false;
      expect(await read(f.visible, privateUrl)).toBeNull();
      expect(calls).toBe(3);
      now += 59_999;
      available = true;
      expect(await read(f.visible, privateUrl)).toBeNull();
      expect(calls).toBe(3);
      now += 1;
      expect(await read(f.visible, privateUrl)).toEqual(CARD);
      expect(calls).toBe(4);
      expect(recorded.lines.some((line) => line['host'] === 'news.example')).toBe(true);
      expect(JSON.stringify(recorded.lines)).not.toContain('never-log-this');
    });
  });

  test.each(['hide', 'delete'] as const)(
    'integration: a %s after the guard cannot return a cached preview',
    async (change) => {
      await withRollback(async (db) => {
        const f = await seed(db);
        let calls = 0;
        const read = make(db, () => {
          calls += 1;
          return Promise.resolve({ kind: 'bytes', bytes: html() });
        });
        await read(f.visible, URL_A);
        if (change === 'hide')
          await db
            .insertInto('hidden_messages')
            .values({
              user_id: f.reader.userId,
              message_id: f.id,
              channel_id: f.room.channelId,
              workspace_id: f.room.workspaceId,
            })
            .execute();
        else await removeMessage(db, fixedClock(NOW), f.author.userId, f.id);
        const failure: unknown = await read(f.visible, URL_A).catch((error: unknown) => error);
        expect(failure).toMatchObject({
          status: 404,
          body: { code: 'MESSAGE_NOT_FOUND' },
        });
        expect(calls).toBe(1);
      });
    },
  );

  test('integration: a changed-away link and unsupported candidates cause no cache or origin work', async () => {
    await withRollback(async (db) => {
      const f = await seed(db);
      let calls = 0;
      const read = make(db, () => {
        calls += 1;
        return Promise.resolve({ kind: 'bytes', bytes: html() });
      });
      await read(f.visible, URL_A);
      await db
        .updateTable('messages')
        .set({ content: 'The link was removed' })
        .where('id', '=', f.id)
        .execute();
      expect(await read(f.visible, URL_A)).toBeNull();
      for (const content of [
        '`https://docs.example/report`',
        'https://user:password@docs.example/report',
        'https://github.com/org/repo/pull/1',
        'https://pictures.example/cover.png',
      ]) {
        await db.updateTable('messages').set({ content }).where('id', '=', f.id).execute();
        expect(await read(f.visible, content)).toBeNull();
      }
      expect(calls).toBe(1);
      expect(
        await db.selectFrom('link_previews').selectAll().where('url', '=', URL_A).execute(),
      ).toHaveLength(1);
    });
  });

  test('integration: invalid cached text is refetched instead of trusted', async () => {
    await withRollback(async (db) => {
      const f = await seed(db);
      let calls = 0;
      const read = make(db, () => {
        calls += 1;
        return Promise.resolve({ kind: 'bytes', bytes: html() });
      });
      await read(f.visible, URL_A);
      await db
        .updateTable('link_previews')
        .set({
          payload: {
            kind: 'card',
            card: { title: '\u202Ebad', description: null, imageUrl: null },
          },
        })
        .execute();
      expect(await read(f.visible, URL_A)).toEqual(CARD);
      expect(calls).toBe(2);
    });
  });

  test('integration: simultaneous cold reads share one origin request, not merely a warm cache', async () => {
    await withRollback(async (db) => {
      const f = await seed(db);
      const origin = Promise.withResolvers<undefined>();
      const started = Promise.withResolvers<string>();
      const checked = Promise.withResolvers<undefined>();
      let statements = 0;
      let completed = 0;
      let watching = false;
      let required = 0;
      let calls = 0;
      const observed = db.withPlugin({
        transformQuery: (args) => {
          statements += 1;
          return args.node;
        },
        transformResult: (args) => {
          completed += 1;
          if (watching) {
            // Observe completed source/cache work, including its continuations, before freeing the origin.
            // This does not assume whether a pending entry is checked before or after the SQL cache.
            setTimeout(() => {
              if (watching && statements >= required && completed === statements) {
                watching = false;
                checked.resolve(undefined);
              }
            }, 0);
          }
          return Promise.resolve(args.result);
        },
      });
      const read = make(observed, async () => {
        calls += 1;
        started.resolve('started');
        await origin.promise;
        return { kind: 'bytes', bytes: html() };
      });
      const first = read(f.visible, URL_A);
      const jobs = [first];
      const deadline = setTimeout(() => {
        checked.reject(new Error('The second source read did not complete'));
        origin.resolve(undefined);
      }, 1_000);
      try {
        expect(await Promise.race([started.promise, first.then(() => 'finished')])).toBe('started');
        required = statements + 1;
        watching = true;
        jobs.push(read(f.visible, URL_A));
        await checked.promise;
        expect(calls).toBe(1);
        origin.resolve(undefined);
        expect(await Promise.all(jobs)).toEqual([CARD, CARD]);
      } finally {
        clearTimeout(deadline);
        watching = false;
        origin.resolve(undefined);
        await Promise.allSettled(jobs);
      }
    });
  });

  test('integration: at most four origins run and twelve jobs are held, with capacity returned after completion', async () => {
    await withRollback(async (db) => {
      const f = await seed(db);
      const sources: { visible: VisibleMessage; url: string }[] = [];
      for (let i = 0; i < 13; i += 1) {
        const url = `https://docs.example/report/${String(i)}`;
        const id = await say(db, f.room, f.author.userId, url);
        sources.push({ url, visible: await requireMessageById(db, f.reader.userId, id) });
      }
      const release = Promise.withResolvers<undefined>();
      let active = 0;
      let peak = 0;
      let calls = 0;
      const read = make(db, async () => {
        calls += 1;
        active += 1;
        peak = Math.max(peak, active);
        try {
          await release.promise;
          return { kind: 'bytes', bytes: html() };
        } finally {
          active -= 1;
        }
      });
      const jobs = sources.slice(0, 12).map((source) => read(source.visible, source.url));
      const excess = sources[12];
      if (excess === undefined) throw new Error('Missing capacity control');
      // A regression that queues the thirteenth job must still release the fixture and fail cleanly.
      const deadline = setTimeout(() => {
        release.resolve(undefined);
      }, 1_000);
      try {
        expect(await read(excess.visible, excess.url)).toBeNull();
        expect(calls).toBe(4);
        release.resolve(undefined);
        expect((await Promise.all(jobs)).every((card) => card?.title === 'Report')).toBe(true);
        expect(calls).toBe(12);
        expect(peak).toBe(4);
        expect(await read(excess.visible, excess.url)).toEqual(CARD);
        expect(calls).toBe(13);
      } finally {
        clearTimeout(deadline);
        release.resolve(undefined);
        await Promise.allSettled(jobs);
      }
    });
  });

  test('integration: an unexpected provider exception propagates and releases its in-flight entry', async () => {
    await withRollback(async (db) => {
      const f = await seed(db);
      let calls = 0;
      const failure = new Error('Provider bug');
      const read = make(db, () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(failure)
          : Promise.resolve({ kind: 'bytes', bytes: html() });
      });
      expect(await read(f.visible, URL_A).catch((error: unknown) => error)).toBe(failure);
      expect(await read(f.visible, URL_A)).toEqual(CARD);
      expect(calls).toBe(2);
    });
  });
});
