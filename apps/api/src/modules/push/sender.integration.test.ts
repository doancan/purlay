/**
 * Telling a device (#78, D-126), through the one send path and real SQL, to a push service of the
 * test's own: who is pushed and who is not, what the browser can read of it — decrypted here with
 * the browser's own key, as the browser would — and what the service's answer does to the device.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { createECDH } from 'node:crypto';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId } from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import type { EventBus } from '../../platform/events';
import { atomicallyOn } from '../../platform/transactions';
import { issueSession } from '../auth/sessions';
import { aRoom, type Room } from '../../testing/rooms';
import { aDatabaseThatMustNotBeTouched, aRecordingLogger } from '../../testing/doubles';
import { edit } from '../messages/edit';
import { send } from '../messages/messages';
import { PUSH_FAILURES_MAX, createPushSender, type PushPost } from './sender';
import type { VapidKeys } from './vapid';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-10-13T12:00:00.000Z');
const clock = fixedClock(NOW);

const quietBus: EventBus = {
  publish: () => Promise.resolve(),
  subscribe: () => false,
  unsubscribe: () => undefined,
  forget: () => undefined,
};

const KEYS: VapidKeys = ((): VapidKeys => {
  const pair = createECDH('prime256v1');
  pair.generateKeys();
  return {
    publicKey: pair.getPublicKey().toString('base64url'),
    privateKey: Buffer.from(pair.getPrivateKey().toString('hex').padStart(64, '0'), 'hex').toString(
      'base64url',
    ),
    subject: 'mailto:ops@example.com',
  };
})();

const text = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);

const hkdf = async (
  salt: Uint8Array<ArrayBuffer>,
  secret: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info },
      await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']),
      length * 8,
    ),
  );

/** A browser: its key pair and secret, and what it does with a body it is sent (RFC 8291). */
const aBrowser = async (): Promise<{
  readonly p256dh: string;
  readonly auth: string;
  readonly read: (body: Uint8Array) => Promise<unknown>;
}> => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  const own = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  const secret = crypto.getRandomValues(new Uint8Array(16));
  return {
    p256dh: Buffer.from(own).toString('base64url'),
    auth: Buffer.from(secret).toString('base64url'),
    read: async (body): Promise<unknown> => {
      const salt = body.slice(0, 16);
      const length = body[20] ?? 0;
      const server = body.slice(21, 21 + length);
      const shared = new Uint8Array(
        await crypto.subtle.deriveBits(
          {
            name: 'ECDH',
            public: await crypto.subtle.importKey(
              'raw',
              server,
              { name: 'ECDH', namedCurve: 'P-256' },
              false,
              [],
            ),
          },
          pair.privateKey,
          256,
        ),
      );
      const joined = new Uint8Array([...text('WebPush: info\0'), ...own, ...server]);
      const ikm = await hkdf(secret, shared, joined, 32);
      const key = await hkdf(salt, ikm, text('Content-Encoding: aes128gcm\0'), 16);
      const nonce = await hkdf(salt, ikm, text('Content-Encoding: nonce\0'), 12);
      const plain = new Uint8Array(
        await crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: nonce },
          await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']),
          body.slice(21 + length),
        ),
      );
      const payload: unknown = JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
      return payload;
    },
  };
};

interface Sent {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

/** A push service answering `status`, keeping what it was sent. */
const aPushService = (status = 201): { post: PushPost; sent: Sent[] } => {
  const sent: Sent[] = [];
  return {
    sent,
    post: (url, headers, body): Promise<{ kind: 'answered'; status: number }> => {
      sent.push({ url: url.href, headers, body });
      return Promise.resolve({ kind: 'answered', status });
    },
  };
};

/** Devices are made in the order a test makes them, a millisecond apart. */
let made = 0;

const subscribeDevice = async (
  db: Executor,
  room: Room,
  who: string,
  browser: { p256dh: string; auth: string },
  over: { endpoint?: string; serverKey?: string; failures?: number } = {},
): Promise<string> => {
  const userId = room.members[who]?.userId ?? '';
  const { sessionId } = await issueSession(db, clock, userId, 30);
  const row = await db
    .insertInto('push_subscriptions')
    .values({
      user_id: userId,
      session_id: sessionId,
      endpoint: over.endpoint ?? `https://push.example.com/send/${who}`,
      p256dh: browser.p256dh,
      auth: browser.auth,
      server_key: over.serverKey ?? KEYS.publicKey,
      failures: over.failures ?? 0,
      created_at: new Date(NOW.getTime() - 60_000 + (made += 1)),
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return row.id;
};

const sending = async (
  db: Executor,
  post: PushPost,
  recording = aRecordingLogger(),
): Promise<{
  readonly say: (room: Room, as: string, content: string, id?: string) => Promise<string>;
  readonly settled: () => Promise<void>;
}> => {
  const push = await createPushSender({
    database: db,
    clock,
    log: recording.log,
    keys: KEYS,
    post,
  });
  let at = 0;
  return {
    say: async (room, as, content, id): Promise<string> => {
      at += 1;
      const context = room.members[as]?.context;
      if (context === undefined) throw new Error(`no member ${as}`);
      const sent = await send(
        { atomically: atomicallyOn(db), clock, bus: quietBus, push },
        context,
        { id: id ?? messageId(new Date(NOW.getTime() + at)), content },
      );
      return sent.id;
    },
    settled: async (): Promise<void> => {
      await push.flush(10_000);
    },
  };
};

const mention = (room: Room, who: string): string => `@${room.members[who]?.username ?? ''}`;

describe('integration: a device is told', () => {
  test('of a mention, in its person’s language, with who and where and never what was said', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const bob = await aBrowser();
      await subscribeDevice(db, room, 'bob', bob);
      await db
        .updateTable('users')
        .set({ locale: 'tr' })
        .where('id', '=', room.members['bob']?.userId ?? '')
        .execute();
      const service = aPushService();
      const { say, settled } = await sending(db, service.post);
      await say(room, 'alice', `${mention(room, 'bob')} the secret plan`);
      await settled();

      expect(service.sent.map((push) => push.url)).toEqual(['https://push.example.com/send/bob']);
      const [push] = service.sent;
      expect(push?.headers['content-encoding']).toBe('aes128gcm');
      expect(push?.headers['authorization']).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
      const channel = await db
        .selectFrom('channels')
        .select('name')
        .where('id', '=', room.channelId)
        .executeTakeFirstOrThrow();
      const read = await bob.read(push?.body ?? new Uint8Array());
      expect(read).toMatchObject({
        title: `#${channel.name ?? ''}`,
        body: 'alice senden bahsetti',
        tag: `channel:${room.channelId}`,
      });
      expect(JSON.stringify(read)).not.toContain('secret');
    });
  });

  test('of a group, titled by its other people and saying it was written to the conversation', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol'], { type: 'direct_message' });
      const bob = await aBrowser();
      await subscribeDevice(db, room, 'bob', bob);
      const service = aPushService();
      const { say, settled } = await sending(db, service.post);
      await say(room, 'alice', 'shipping at five');
      await settled();
      const [push] = service.sent;
      const read = await bob.read(push?.body ?? new Uint8Array());
      const others = ['alice', 'carol'];
      expect(read).toMatchObject({ body: 'alice wrote to the conversation' });
      const title = (read as { title: string }).title;
      expect(title.split(', ').sort()).toEqual(others);
    });
  });

  test('once: a retried send tells nobody again, and the author is never told', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await subscribeDevice(db, room, 'alice', await aBrowser());
      await subscribeDevice(db, room, 'bob', await aBrowser());
      const service = aPushService();
      const { say, settled } = await sending(db, service.post);
      const id = messageId(NOW);
      await say(room, 'alice', `${mention(room, 'bob')} ping`, id);
      await say(room, 'alice', `${mention(room, 'bob')} ping`, id);
      await settled();
      expect(service.sent.map((push) => push.url)).toEqual(['https://push.example.com/send/bob']);
    });
  });

  test('of a mention an edit added, once however often it is saved', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await subscribeDevice(db, room, 'bob', await aBrowser());
      const service = aPushService();
      const push = await createPushSender({
        database: db,
        clock,
        log: aRecordingLogger().log,
        keys: KEYS,
        post: service.post,
      });
      const { say } = await sending(db, service.post);
      const id = await say(room, 'alice', 'see the plan');
      const { sessionId } = await issueSession(db, clock, room.members['alice']?.userId ?? '', 30);
      const caller = { userId: room.members['alice']?.userId ?? '', sessionId };
      const editing = { atomically: atomicallyOn(db), clock, bus: quietBus, push };
      await edit(editing, caller, id, `see the plan ${mention(room, 'bob')}`);
      await edit(editing, caller, id, `see the plan, ${mention(room, 'bob')}`);
      await push.flush();
      expect(service.sent.map((sent) => sent.url)).toEqual(['https://push.example.com/send/bob']);
    });
  });

  test('not of a message that needs nobody, nor in Deep Work, nor in a muted channel', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol']);
      await subscribeDevice(db, room, 'bob', await aBrowser());
      await subscribeDevice(db, room, 'carol', await aBrowser());
      await db
        .updateTable('workspace_members')
        .set({ is_deep_work_active: true, deep_work_until: new Date(NOW.getTime() + 3_600_000) })
        .where('user_id', '=', room.members['bob']?.userId ?? '')
        .execute();
      await db
        .updateTable('channel_members')
        .set({ notification_level: 'none' })
        .where('user_id', '=', room.members['carol']?.userId ?? '')
        .execute();
      const service = aPushService();
      const { say, settled } = await sending(db, service.post);
      await say(room, 'alice', 'a plain message');
      await say(room, 'alice', `${mention(room, 'bob')} ${mention(room, 'carol')} look`);
      await settled();
      expect(service.sent).toEqual([]);
    });
  });

  test('not of a message its person has already read past', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await subscribeDevice(db, room, 'bob', await aBrowser());
      const service = aPushService();
      const { say, settled } = await sending(db, service.post);
      // Bob has read up to a message newer than the one about to be sent.
      const later = await say(room, 'alice', 'newer', messageId(new Date(NOW.getTime() + 1_000)));
      await db
        .updateTable('channel_members')
        .set({ last_read_message_id: later })
        .where('user_id', '=', room.members['bob']?.userId ?? '')
        .execute();
      await say(room, 'alice', `${mention(room, 'bob')} older`, messageId(NOW));
      await settled();
      expect(service.sent).toEqual([]);
    });
  });

  test('not on a device of a session signed out, nor one made with a key since replaced', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol']);
      await subscribeDevice(db, room, 'bob', await aBrowser());
      await db
        .updateTable('sessions')
        .set({ revoked_at: NOW })
        .where('user_id', '=', room.members['bob']?.userId ?? '')
        .execute();
      await subscribeDevice(db, room, 'carol', await aBrowser(), {
        serverKey: `B${'x'.repeat(86)}`,
      });
      const service = aPushService();
      const { say, settled } = await sending(db, service.post);
      await say(room, 'alice', `${mention(room, 'bob')} ${mention(room, 'carol')} look`);
      await settled();
      expect(service.sent).toEqual([]);
    });
  });
});

describe('integration: what the push service answers', () => {
  const answered = async (
    status: number,
    failures = 0,
  ): Promise<{ failures: number } | undefined> => {
    let kept: { failures: number } | undefined;
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const id = await subscribeDevice(db, room, 'bob', await aBrowser(), { failures });
      const { say, settled } = await sending(db, aPushService(status).post);
      await say(room, 'alice', `${mention(room, 'bob')} ping`);
      await settled();
      kept = await db
        .selectFrom('push_subscriptions')
        .select('failures')
        .where('id', '=', id)
        .executeTakeFirst();
    });
    return kept;
  };

  test('taken, it keeps the device and forgets its failures', async () => {
    expect(await answered(201, 3)).toEqual({ failures: 0 });
  });

  test.each([404, 410])('%p — the browser dropped it — forgets the device', async (status) => {
    expect(await answered(status)).toBeUndefined();
  });

  test('anything else counts a failure, and the last one allowed forgets the device', async () => {
    expect(await answered(500)).toEqual({ failures: 1 });
    expect(await answered(429, PUSH_FAILURES_MAX - 2)).toEqual({ failures: PUSH_FAILURES_MAX - 1 });
    expect(await answered(500, PUSH_FAILURES_MAX - 1)).toBeUndefined();
  });

  test.each([400, 401, 403, 413])(
    '%p — this server’s request refused — is said loudly, and is no device’s fault',
    async (status) => {
      await withRollback(async (db) => {
        const room = await aRoom(db, ['alice', 'bob']);
        const id = await subscribeDevice(db, room, 'bob', await aBrowser(), { failures: 2 });
        const recording = aRecordingLogger();
        const { say, settled } = await sending(db, aPushService(status).post, recording);
        await say(room, 'alice', `${mention(room, 'bob')} ping`);
        await settled();
        expect(
          await db
            .selectFrom('push_subscriptions')
            .select('failures')
            .where('id', '=', id)
            .execute(),
        ).toEqual([{ failures: 2 }]);
        expect(
          recording.lines.map((line) => [line['level'], line['msg'], line['status']]),
        ).toContainEqual(['error', 'push refused: this server’s request', status]);
      });
    },
  );

  test('one person’s slow push services do not hold anybody else’s', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol']);
      for (const n of [1, 2, 3]) {
        await subscribeDevice(db, room, 'bob', await aBrowser(), {
          endpoint: `https://slow.example.com/${String(n)}`,
        });
      }
      await subscribeDevice(db, room, 'carol', await aBrowser());
      const posted: string[] = [];
      const held: (() => void)[] = [];
      let released = false;
      const post: PushPost = (url) => {
        posted.push(url.href);
        if (url.hostname !== 'slow.example.com' || released) {
          return Promise.resolve({ kind: 'answered', status: 201 });
        }
        return new Promise((resolve) => {
          held.push(() => {
            resolve({ kind: 'answered', status: 201 });
          });
        });
      };
      const { say, settled } = await sending(db, post);
      await say(room, 'alice', `${mention(room, 'bob')} ${mention(room, 'carol')} look`);
      // Carol's push goes while two of Bob's hang, and Bob's third waits for one of his own.
      for (
        let turn = 0;
        turn < 50 && !posted.includes('https://push.example.com/send/carol');
        turn++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(posted.filter((url) => url.startsWith('https://slow.example.com/'))).toHaveLength(2);
      expect(posted).toContain('https://push.example.com/send/carol');
      released = true;
      for (const release of held) release();
      await settled();
      expect(posted.filter((url) => url.startsWith('https://slow.example.com/'))).toHaveLength(3);
    });
  });

  test('a device that moved to somebody else before its turn is not sent to', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob', 'carol']);
      const ids: string[] = [];
      for (const n of [1, 2, 3]) {
        ids.push(
          await subscribeDevice(db, room, 'bob', await aBrowser(), {
            endpoint: `https://push.example.com/bob/${String(n)}`,
          }),
        );
      }
      const { sessionId } = await issueSession(db, clock, room.members['carol']?.userId ?? '', 30);
      const posted: string[] = [];
      let moved = false;
      const post: PushPost = async (url) => {
        posted.push(url.href);
        if (!moved) {
          moved = true;
          // While Bob's first two go, his third is signed into by Carol on its browser.
          await db
            .updateTable('push_subscriptions')
            .set({ user_id: room.members['carol']?.userId ?? '', session_id: sessionId })
            .where('id', '=', ids[2] ?? '')
            .execute();
        }
        return { kind: 'answered', status: 201 };
      };
      const { say, settled } = await sending(db, post);
      await say(room, 'alice', `${mention(room, 'bob')} look`);
      await settled();
      expect(posted).toHaveLength(2);
      expect(posted).not.toContain('https://push.example.com/bob/3');
    });
  });

  test('a device whose session was signed out while its push waited is not sent to', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const ids: string[] = [];
      for (const n of [1, 2, 3]) {
        ids.push(
          await subscribeDevice(db, room, 'bob', await aBrowser(), {
            endpoint: `https://push.example.com/bob/${String(n)}`,
          }),
        );
      }
      const posted: string[] = [];
      let signedOut = false;
      const post: PushPost = async (url) => {
        posted.push(url.href);
        if (!signedOut) {
          signedOut = true;
          // While Bob's first two go, he signs out of the browser his third is on.
          const third = await db
            .selectFrom('push_subscriptions')
            .select('session_id')
            .where('id', '=', ids[2] ?? '')
            .executeTakeFirstOrThrow();
          await db
            .updateTable('sessions')
            .set({ revoked_at: NOW })
            .where('id', '=', third.session_id)
            .execute();
        }
        return { kind: 'answered', status: 201 };
      };
      const { say, settled } = await sending(db, post);
      await say(room, 'alice', `${mention(room, 'bob')} look`);
      await settled();
      expect(posted).toHaveLength(2);
      expect(posted).not.toContain('https://push.example.com/bob/3');
    });
  });

  test('one device’s failure is said, and the person’s other devices are still told', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      for (const n of [1, 2]) {
        await subscribeDevice(db, room, 'bob', await aBrowser(), {
          endpoint: `https://push.example.com/bob/${String(n)}`,
        });
      }
      const posted: string[] = [];
      const post: PushPost = (url) => {
        posted.push(url.href);
        return url.pathname.endsWith('/1')
          ? Promise.reject(new Error('the socket broke'))
          : Promise.resolve({ kind: 'answered', status: 201 });
      };
      const recording = aRecordingLogger();
      const { say, settled } = await sending(db, post, recording);
      await say(room, 'alice', `${mention(room, 'bob')} look`);
      await settled();
      expect(posted.sort()).toEqual([
        'https://push.example.com/bob/1',
        'https://push.example.com/bob/2',
      ]);
      expect(recording.lines.map((line) => line['msg'])).toContain('push delivery failed');
    });
  });

  test('a database that fails while the devices are found is said, with the message', async () => {
    const recording = aRecordingLogger();
    const push = await createPushSender({
      database: aDatabaseThatMustNotBeTouched(new Error('the database is down')),
      clock,
      log: recording.log,
      keys: KEYS,
      post: () => Promise.reject(new Error('nothing is posted')),
    });
    push.told('m-1', ['u-1']);
    await push.flush(1_000);
    expect(
      recording.lines.map((line) => [line['level'], line['msg'], line['messageId'], line['stage']]),
    ).toContainEqual(['error', 'push delivery failed', 'm-1', 'finding devices']);
  });

  test('past the pushes that may wait, the rest are dropped and said', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const userId = room.members['bob']?.userId ?? '';
      const { sessionId } = await issueSession(db, clock, userId, 30);
      const browser = await aBrowser();
      await db
        .insertInto('push_subscriptions')
        .values(
          Array.from({ length: 1_001 }, (_, n) => ({
            user_id: userId,
            session_id: sessionId,
            endpoint: `https://push.example.com/many/${String(n)}`,
            p256dh: browser.p256dh,
            auth: browser.auth,
            server_key: KEYS.publicKey,
          })),
        )
        .execute();
      const service = aPushService();
      const recording = aRecordingLogger();
      const { say, settled } = await sending(db, service.post, recording);
      await say(room, 'alice', `${mention(room, 'bob')} look`);
      await settled();
      expect(service.sent).toHaveLength(1_000);
      expect(
        recording.lines.find((line) => line['msg'] === 'push dropped: too many waiting'),
      ).toMatchObject({ dropped: 1 });
    });
  });

  test('a shutdown waits for pushes on their way only as long as its bound, and says what it left', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      await subscribeDevice(db, room, 'bob', await aBrowser());
      const recording = aRecordingLogger();
      const push = await createPushSender({
        database: db,
        clock,
        log: recording.log,
        keys: KEYS,
        post: () => new Promise(() => undefined),
      });
      const context = room.members['alice']?.context;
      if (context === undefined) throw new Error('no alice');
      await send({ atomically: atomicallyOn(db), clock, bus: quietBus, push }, context, {
        id: messageId(NOW),
        content: `${mention(room, 'bob')} ping`,
      });
      await push.flush(50);
      expect(recording.lines.map((line) => [line['msg'], line['running']])).toContainEqual([
        'pushes left at shutdown',
        1,
      ]);
    });
  });

  test('an endpoint push may never reach is forgotten without being tried', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['alice', 'bob']);
      const id = await subscribeDevice(db, room, 'bob', await aBrowser(), {
        endpoint: 'https://10.0.0.7/push',
      });
      const service = aPushService();
      const { say, settled } = await sending(db, service.post);
      await say(room, 'alice', `${mention(room, 'bob')} ping`);
      await settled();
      expect(service.sent).toEqual([]);
      expect(
        await db.selectFrom('push_subscriptions').select('id').where('id', '=', id).execute(),
      ).toEqual([]);
    });
  });
});
