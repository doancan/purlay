/** Metadata authority and costly-read charging through the real application. */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { Value } from '@sinclair/typebox/value';
import { messageId, WebLinkPreviewResponse } from '@purlay/types';
import { compose } from '../../../composition';
import { createApp } from '../../../ingress/http/app';
import { fixedClock } from '../../../platform/clock';
import { SESSION_COOKIE } from '../../../platform/cookies';
import { testDependencies } from '../../../testing/doubles';
import { aRoom, type Room } from '../../../testing/rooms';
import { aSession, aSignedInUser } from '../../../testing/signed-in';
import { chatModule } from '../module';
import { chatRoutes } from './routes';

afterAll(async () => {
  await closeIntegrationDatabase();
});
const clock = fixedClock(new Date('2026-11-07T12:00:00.000Z'));
const url = 'https://docs.example/report';
interface AskOptions {
  cookie?: string;
  id?: string;
  path?: string;
  raw?: string;
}
interface Fixture {
  readonly app: ReturnType<typeof createApp>;
  readonly room: Room;
  readonly reader: Room['members'][string];
  readonly id: string;
  readonly ask: (body?: unknown, options?: AskOptions) => Promise<Response>;
  readonly cookie: string;
  readonly origins: () => number;
}
const fixture = async (database: Executor, limits = false): Promise<Fixture> => {
  const room = await aRoom(database, ['author', 'reader']);
  const author = room.members['author'];
  const reader = room.members['reader'];
  if (author === undefined || reader === undefined) throw new Error('Missing fixture people');
  const session = await aSession(database, clock, reader.userId);
  const id = messageId(clock.now());
  await database
    .insertInto('messages')
    .values({
      id,
      workspace_id: room.workspaceId,
      channel_id: room.channelId,
      sender_id: author.userId,
      content: url,
    })
    .execute();
  let origins = 0;
  const module = {
    ...chatModule,
    routes: (context: Parameters<typeof chatRoutes>[0]): ReturnType<typeof chatRoutes> =>
      chatRoutes({
        ...context,
        previewFetch: (): Promise<{ kind: 'bytes'; bytes: Uint8Array }> => {
          origins += 1;
          return Promise.resolve({
            kind: 'bytes',
            bytes: new TextEncoder().encode('<title>Vardiya planı</title>'),
          });
        },
      }),
  };
  const app = createApp(
    testDependencies({
      database,
      clock,
      composition: compose([module], [module]),
      ...(limits
        ? {
            rateBudgets: {
              auth: { perSecond: 1, burst: 100 },
              writes: { perSecond: 1, burst: 2 },
              costlyReads: { perSecond: 1, burst: 2 },
            },
          }
        : {}),
    }),
  );
  const cookie = `${SESSION_COOKIE}=${session.token}`;
  const ask = async (body: unknown = { url }, options: AskOptions = {}): Promise<Response> =>
    await app.handle(
      new Request(
        `https://purlay.test${options.path ?? `/api/messages/${options.id ?? id}/link-preview`}`,
        {
          method: 'POST',
          headers: { cookie: options.cookie ?? cookie, 'content-type': 'application/json' },
          body: options.raw ?? JSON.stringify(body),
        },
      ),
    );
  return { app, room, reader, id, ask, cookie, origins: (): number => origins };
};

describe('integration: public web previews', () => {
  test('integration: returns bounded metadata for a current message without marking it read', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      const response = await f.ask();
      expect(response.status).toBe(200);
      const answer: unknown = await response.json();
      expect(Value.Check(WebLinkPreviewResponse, answer)).toBe(true);
      expect(answer).toEqual({ title: 'Vardiya planı', description: null, imageUrl: null });
      expect(f.origins()).toBe(1);
      expect((await f.ask({ url: 'https://absent.example/other' })).status).toBe(200);
      expect(f.origins()).toBe(1);
    });
  });

  test('integration: current message authority precedes body validation and cached metadata', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      expect((await f.ask()).status).toBe(200);
      expect((await f.ask({}, { cookie: '' })).status).toBe(401);
      const outsider = await aSignedInUser(db, clock, 'preview-outsider');
      expect((await f.ask({}, { cookie: outsider.cookie })).status).toBe(404);
      expect((await f.ask({}, { id: 'not-a-uuid' })).status).toBe(404);
      await db
        .deleteFrom('workspace_members')
        .where('workspace_id', '=', f.room.workspaceId)
        .where('user_id', '=', f.reader.userId)
        .execute();
      expect((await f.ask({ url })).status).toBe(404);
      expect(f.origins()).toBe(1);
    });
  });

  test('integration: malformed and extra input is refused; unsupported selected addresses stay ordinary links', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db);
      for (const body of [
        {},
        null,
        [],
        { url: 3 },
        { url: 'http://docs.example/report' },
        { url: 'https://docs.example', token: 'no' },
        { url: `https://docs.example/${'x'.repeat(2048)}` },
      ]) {
        expect((await f.ask(body)).status).toBe(400);
      }
      expect((await f.ask({}, { raw: '{' })).status).toBe(400);
      for (const address of [
        'https://127.0.0.1/',
        'https://user:password@docs.example/report',
        'https://docs.example:8443/report',
        'https://localhost/',
      ]) {
        await db.updateTable('messages').set({ content: address }).where('id', '=', f.id).execute();
        const response = await f.ask({ url: address });
        expect(response.status).toBe(200);
        expect(await response.json()).toBeNull();
      }
      expect(f.origins()).toBe(0);
    });
  });

  test('integration: preview paths share the costly-read bucket, including router slash normalization, without spending sending', async () => {
    await withRollback(async (db) => {
      const f = await fixture(db, true);
      expect((await f.ask()).status).toBe(200);
      expect((await f.ask({ url }, { path: `/api/messages/${f.id}/link-preview/` })).status).toBe(
        200,
      );
      expect((await f.ask()).status).toBe(429);
      const sent = await f.app.handle(
        new Request(`https://purlay.test/api/channels/${f.room.channelId}/messages`, {
          method: 'POST',
          headers: { cookie: f.cookie, 'content-type': 'application/json' },
          body: JSON.stringify({
            id: messageId(new Date(clock.now().getTime() + 1)),
            content: 'The message still sends',
          }),
        }),
      );
      expect(sent.status).toBe(201);
      expect(f.origins()).toBe(1);
    });
  });
});
