/** Real socket admission and frame scope retain company origin; independent login stays independent. @needs-modules chat */
import { describe, afterAll, beforeAll, expect, test } from 'bun:test';
import {
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  type ClonedDatabase,
} from '@purlay/db';
import { messageId, parseServerMessage, type ClientFrame, type ServerFrame } from '@purlay/types';
import { createApp } from '../http/app';
import { systemClock } from '../../platform/clock';
import { testDependencies } from '../../testing/doubles';
import { signInCompanyNative } from '../../testing/company-native-auth';
import { aRoom } from '../../testing/rooms';

describe('integration: company-session', () => {
  let clone: ClonedDatabase;
  beforeAll(async () => {
    clone = await cloneIntegrationDatabase();
  }, CLONE_HOOK_MS);
  afterAll(async () => {
    await clone.drop();
    await closeIntegrationDatabase();
  }, DROP_HOOK_MS);

  const connect = async (
    url: string,
    cookie: string,
  ): Promise<{
    readonly socket: WebSocket;
    readonly ask: (frame: ClientFrame) => Promise<ServerFrame>;
  }> => {
    // Bun's header-bearing overload is absent from the DOM WebSocket type, as in the existing socket suites.
    const socket = new WebSocket(url, {
      headers: { cookie, origin: 'https://purlay.test' },
    } as unknown as string[]);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Company socket did not open'));
      }, 2_000);
      socket.addEventListener(
        'open',
        () => {
          clearTimeout(timeout);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        'error',
        () => {
          clearTimeout(timeout);
          reject(new Error('Company socket upgrade failed'));
        },
        { once: true },
      );
    });
    return {
      socket,
      ask: async (frame): Promise<ServerFrame> =>
        await new Promise((resolve, reject) => {
          const finish = (answer: ServerFrame | undefined): void => {
            clearTimeout(timeout);
            socket.removeEventListener('message', receive);
            if (answer === undefined) reject(new Error('Company frame was not answered'));
            else resolve(answer);
          };
          const receive = (event: MessageEvent): void => {
            const parsed = parseServerMessage(String(event.data));
            if (parsed.kind === 'malformed') finish(undefined);
            else if (parsed.kind === 'frame' && parsed.frame.refId === frame.id)
              finish(parsed.frame);
          };
          const timeout = setTimeout(() => {
            finish(undefined);
          }, 2_000);
          socket.addEventListener('message', receive);
          socket.send(JSON.stringify(frame));
        }),
    };
  };

  test('real company frames refuse foreign subscriptions and sends while the independent session still works', async () => {
    const world = await signInCompanyNative(clone.db);
    const other = await aRoom(clone.db, ['foreign-wire-owner']);
    await clone.db
      .insertInto('workspace_members')
      .values({
        workspace_id: other.workspaceId,
        user_id: world.companySession.userId,
        role: 'member',
      })
      .execute();
    await clone.db
      .insertInto('channel_members')
      .values({ channel_id: other.channelId, user_id: world.companySession.userId })
      .execute();
    const own = await clone.db
      .selectFrom('channels')
      .select('id')
      .where('workspace_id', '=', world.fixture.member.context.workspaceId)
      .executeTakeFirstOrThrow();
    const app = createApp(
      testDependencies({ database: clone.db, auth: world.auth, clock: systemClock }),
    );
    const port = app.listen(0);
    let company: Awaited<ReturnType<typeof connect>> | undefined;
    let independent: Awaited<ReturnType<typeof connect>> | undefined;
    try {
      company = await connect(`ws://localhost:${String(port)}/ws`, world.cookie);
      independent = await connect(`ws://localhost:${String(port)}/ws`, world.memberCookie);
      const deniedSubscription = await company.ask({
        id: messageId(systemClock.now()),
        op: 'SUBSCRIBE',
        payload: { channels: [{ channelId: other.channelId, afterMessageId: null }] },
      });
      expect(deniedSubscription.event).toBe('ERROR');
      const ownSubscription = await company.ask({
        id: messageId(systemClock.now()),
        op: 'SUBSCRIBE',
        payload: { channels: [{ channelId: own.id, afterMessageId: null }] },
      });
      expect(ownSubscription.event).toBe('ACK');
      const deniedId = messageId(systemClock.now());
      const deniedSend = await company.ask({
        id: deniedId,
        op: 'MESSAGE_SEND',
        payload: { channelId: other.channelId, content: 'Must stay outside the other company' },
      });
      expect(deniedSend.event).toBe('ERROR');
      expect(
        await clone.db.selectFrom('messages').select('id').where('id', '=', deniedId).execute(),
      ).toEqual([]);
      const independentSubscription = await independent.ask({
        id: messageId(systemClock.now()),
        op: 'SUBSCRIBE',
        payload: { channels: [{ channelId: other.channelId, afterMessageId: null }] },
      });
      expect(independentSubscription.event).toBe('ACK');
      const independentId = messageId(systemClock.now());
      const independentSend = await independent.ask({
        id: independentId,
        op: 'MESSAGE_SEND',
        payload: { channelId: other.channelId, content: 'Independent authority is preserved' },
      });
      expect(independentSend.event).toBe('ACK');
      expect(
        (
          await clone.db
            .selectFrom('messages')
            .select('id')
            .where('id', '=', independentId)
            .executeTakeFirstOrThrow()
        ).id,
      ).toBe(independentId);
      const ownId = messageId(systemClock.now());
      expect(
        (
          await company.ask({
            id: ownId,
            op: 'MESSAGE_SEND',
            payload: { channelId: own.id, content: 'Company chat still works' },
          })
        ).event,
      ).toBe('ACK');
    } finally {
      company?.socket.close();
      independent?.socket.close();
      await app.stop(true);
    }
  });
});
