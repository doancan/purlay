/**
 * Every way visibility ends, through real sockets on two nodes (#238, D-85).
 *
 * Two applications share one database and one backplane in this process, which is
 * what two nodes behind a balancer are. A socket is held by node B; the change is
 * made on node A, or published from a third node that holds no sockets. Phase 0
 * has no endpoint that removes a member or deletes a user, so each test makes the
 * change the way Phase 1's endpoints will — it deletes the rows, then calls the
 * publish function they are required to call.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  type ClonedDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  sql,
} from '@purlay/db';
import { CLOSE_CODES, messageId, Workspace, MeResponse, type ServerFrame } from '@purlay/types';
import { Value } from '@sinclair/typebox/value';
import { ServerFrame as ServerFrameSchema } from '@purlay/types';
import { createApp, type HttpApplication } from '../ingress/http/app';
import { aSignedInUser, type SignedInUser } from '../testing/signed-in';
import { testConfig, testDependencies } from '../testing/doubles';
import { fixedClock, systemClock } from '../platform/clock';
import { requireWorkspaceMembership } from '../platform/tenancy';
import { createGuestInvitation } from '../modules/workspaces/guest-invitations';
import { acceptInvitation } from '../modules/workspaces/invitations';
import { chatWorkspaceChannels } from '../features/chat/channels/workspace-channels';
import { announcePresence } from '../features/chat/presence/presence';
import {
  publishAccessRevoked,
  publishChannelRevoked,
  publishUserDeleted,
  channelTopic,
} from '../platform/events';
import { createLogger } from '../platform/logging';
import { aUniqueSlug } from '../testing/users';
import { theDefaultChannelOf } from '../testing/channels';
import { inProcessBackplane, type Backplane, type InspectableEventBus } from './bus';

const origin = 'https://purlay.test';
const NOW = new Date('2026-09-09T12:00:00.000Z');
const clock = fixedClock(NOW);

let cloned: ClonedDatabase;
let nodeBDatabase: ClonedDatabase['db'];
let nodeA: HttpApplication;
let nodeB: HttpApplication;
let portB = 0;
/** A node that holds no sockets: where a service on a third process would publish. */
let publisher: InspectableEventBus;
/**
 * Set by a test that wants something to happen inside the read that authorises the next
 * subscription of node B — its top-level channel-scope SELECT, not a nested presence lookup. "The next read"
 * would be spent by whichever read that follows the socket's identity is still in flight when it is set (its
 * presence, its workspaces), and the removal would then land before the subscription instead of
 * inside its authorisation.
 */
let duringAuthorisation: (() => Promise<void>) | undefined;
let authorisationChannelId: string | undefined;
/** Hold a real presence result without stalling the socket's identity or PING/PONG. */
let beforePresenceResult: (() => Promise<void>) | undefined;
const authorisations = new Set<unknown>();
const presenceReads = new Set<unknown>();

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
  const backplane = inProcessBackplane();
  publisher = backplane.node(() => undefined, createLogger({ level: 'silent' }));
  const config = testConfig({ APP_URL: origin });
  nodeA = createApp(testDependencies({ database: cloned.db, clock, config, backplane }));
  // Node B reads through a plugin that can run something inside a read, so a
  // revocation can be published at the exact point a subscription is authorised.
  nodeBDatabase = cloned.db.withPlugin({
    transformQuery: (args) => {
      const channelAuthority =
        authorisationChannelId !== undefined &&
        args.node.kind === 'SelectQueryNode' &&
        args.node.selections?.some(
          ({ selection }) =>
            selection.kind === 'AliasNode' &&
            selection.alias.kind === 'IdentifierNode' &&
            'name' in selection.alias &&
            selection.alias.name === 'guestSince',
        ) === true &&
        JSON.stringify(args.node.where).includes('"operator":"in"') &&
        JSON.stringify(args.node.where).includes(JSON.stringify(authorisationChannelId));
      if (channelAuthority) authorisations.add(args.queryId);
      if (
        args.node.kind === 'SelectQueryNode' &&
        args.node.from?.froms.some(
          (from) =>
            from.kind === 'AliasNode' &&
            'alias' in from &&
            typeof from.alias === 'object' &&
            from.alias !== null &&
            'kind' in from.alias &&
            from.alias.kind === 'IdentifierNode' &&
            'name' in from.alias &&
            from.alias.name === 'mine',
        ) === true
      )
        presenceReads.add(args.queryId);
      return args.node;
    },
    transformResult: async (args) => {
      if (presenceReads.delete(args.queryId)) await beforePresenceResult?.();
      if (authorisations.delete(args.queryId)) {
        const run = duringAuthorisation;
        duringAuthorisation = undefined;
        authorisationChannelId = undefined;
        if (run !== undefined) await run();
      }
      return args.result;
    },
  });
  nodeB = createApp(testDependencies({ database: nodeBDatabase, clock, config, backplane }));
  portB = nodeB.listen(0);
}, CLONE_HOOK_MS);

afterAll(async () => {
  await nodeB.stop(true);
  await cloned.drop();
}, DROP_HOOK_MS);

const http = async (
  method: string,
  path: string,
  cookie: string,
  body?: unknown,
): Promise<Response> =>
  await nodeA.handle(
    new Request(`${origin}${path}`, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );

interface Room {
  readonly alice: SignedInUser;
  readonly bob: SignedInUser;
  readonly workspaceId: string;
  readonly channelId: string;
}

/** Alice owns a workspace and a channel; Bob is a member of both. */
const aRoom = async (): Promise<Room> => {
  const alice = await aSignedInUser(cloned.db, clock, 'alice');
  const bob = await aSignedInUser(cloned.db, clock, 'bob');
  const slug = aUniqueSlug('rev');
  const workspaceId = (
    (await (await http('POST', '/api/workspaces', alice.cookie, { name: slug, slug })).json()) as {
      id: string;
    }
  ).id;
  await cloned.db
    .insertInto('workspace_members')
    .values({ workspace_id: workspaceId, user_id: bob.userId, role: 'member', joined_at: NOW })
    .execute();
  const channelId = (
    (await (
      await http('POST', `/api/workspaces/${workspaceId}/channels`, alice.cookie, {
        name: 'ops',
      })
    ).json()) as { id: string }
  ).id;
  expect((await http('POST', `/api/channels/${channelId}/join`, bob.cookie)).ok).toBe(true);
  return { alice, bob, workspaceId, channelId };
};

interface Client {
  readonly frames: ServerFrame[];
  readonly send: (frame: unknown) => void;
  readonly until: (
    done: (frames: readonly ServerFrame[]) => boolean,
    what: string,
  ) => Promise<void>;
  readonly close: () => Promise<void>;
  readonly ended: Promise<number>;
}

/** A socket held by node B. */
const connect = async (cookie: string, port = portB): Promise<Client> => {
  const socket = new WebSocket(`ws://localhost:${String(port)}/ws`, {
    headers: { cookie, origin },
  } as unknown as string[]);
  const ended = new Promise<number>((resolve) => {
    socket.addEventListener('close', (event) => {
      resolve(event.code);
    });
  });
  const frames: ServerFrame[] = [];
  socket.addEventListener('message', (event) => {
    const received: unknown = JSON.parse(String(event.data));
    if (Value.Check(ServerFrameSchema, received)) frames.push(received);
    else throw new Error(`a frame outside the contract: ${String(event.data)}`);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => {
      resolve();
    });
    socket.addEventListener('error', () => {
      reject(new Error('the socket did not open'));
    });
  });
  return {
    frames,
    send: (frame): void => {
      socket.send(JSON.stringify(frame));
    },
    until: async (done, what): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (!done(frames)) {
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for ${what}; saw ${JSON.stringify(frames.map((f) => f.event))}`,
          );
        }
        await Bun.sleep(10);
      }
    },
    close: async (): Promise<void> => {
      socket.close();
      await ended;
    },
    ended,
  };
};

const subscribe = async (client: Client, channelId: string): Promise<void> => {
  const id = messageId(NOW);
  client.send({
    id,
    op: 'SUBSCRIBE',
    payload: { channels: [{ channelId, afterMessageId: null }] },
  });
  await client.until(
    (frames) => frames.some((f) => f.refId === id),
    'the subscription to be answered',
  );
};

/** Waits for an answer to a PING: anything delivered to the socket before it has arrived. */
const settle = async (client: Client): Promise<void> => {
  const id = messageId(new Date(NOW.getTime() + 500));
  client.send({ id, op: 'PING', payload: {} });
  await client.until((frames) => frames.some((f) => f.refId === id), 'the PONG');
};

const post = async (cookie: string, channelId: string, at: number): Promise<string> => {
  const id = messageId(new Date(NOW.getTime() + at));
  expect(
    (
      await http('POST', `/api/channels/${channelId}/messages`, cookie, {
        id,
        content: `m${String(at)}`,
      })
    ).status,
  ).toBe(201);
  return id;
};

const created = (frames: readonly ServerFrame[]): string[] =>
  frames.flatMap((f) => (f.event === 'MESSAGE_CREATED' ? [f.data.id] : []));

describe('integration: restricted guest history on real sockets', () => {
  test.each(['converted', 'extended', 'expired'] as const)(
    'a captured deadline reauthorizes a %s guest on a real connection without a conversion hint',
    async (change) => {
      const instant = { at: new Date() };
      const lifetime = { now: (): Date => instant.at };
      const underlying = inProcessBackplane();
      let withheld = 0;
      const backplane: Backplane = {
        node: (deliver, log, onGap): InspectableEventBus => {
          const bus = underlying.node(deliver, log, onGap);
          return {
            ...bus,
            publish: async (topic, frame): Promise<void> => {
              if (frame.event === 'WORKSPACE_UPDATED' && frame.data.accessChanged === true) {
                withheld += 1;
                return;
              }
              await bus.publish(topic, frame);
            },
          };
        },
      };
      const app = createApp(
        testDependencies({
          database: cloned.db,
          clock: lifetime,
          config: testConfig({ APP_URL: origin }),
          backplane,
        }),
      );
      const port = app.listen(0);
      const send = async (
        cookie: string,
        method: string,
        path: string,
        body?: unknown,
      ): Promise<Response> =>
        await app.handle(
          new Request(origin + path, {
            method,
            headers: {
              cookie,
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
      let client: Client | undefined;
      try {
        const owner = await aSignedInUser(cloned.db, lifetime, 'expiry-owner');
        const guest = await aSignedInUser(cloned.db, lifetime, 'expiry-guest');
        const slug = aUniqueSlug('expiry');
        const response = await send(owner.cookie, 'POST', '/api/workspaces', { name: slug, slug });
        expect(response.status).toBe(201);
        const workspace: unknown = await response.json();
        if (!Value.Check(Workspace, workspace)) throw new Error('Invalid expiry workspace fixture');
        const channelId = await theDefaultChannelOf(cloned.db, workspace.id);
        const end = new Date(Date.now() + 10_000);
        const since = new Date(Date.now() - 60_000);
        await cloned.db
          .insertInto('workspace_members')
          .values({
            workspace_id: workspace.id,
            user_id: guest.userId,
            role: 'member',
            access_kind: 'guest',
            guest_since: since,
            guest_expires_at: end,
            guest_modules: ['chat'],
          })
          .execute();
        await cloned.db
          .insertInto('channel_members')
          .values({
            channel_id: channelId,
            user_id: guest.userId,
            joined_at: since,
          })
          .execute();
        client = await connect(guest.cookie, port);
        const ref = messageId(lifetime.now());
        client.send({
          id: ref,
          op: 'SUBSCRIBE',
          payload: { channels: [{ channelId, afterMessageId: null }] },
        });
        await client.until(
          (frames) => frames.some((frame) => frame.refId === ref && frame.event === 'ACK'),
          'guest subscription',
        );
        if (change === 'converted') {
          expect(
            (
              await send(
                owner.cookie,
                'POST',
                `/api/workspaces/${workspace.id}/guests/${guest.userId}/conversion`,
                { confirmFullAccess: true },
              )
            ).status,
          ).toBe(200);
          expect(withheld).toBe(1);
        } else {
          await cloned.db
            .updateTable('workspace_members')
            .set({
              guest_expires_at:
                change === 'extended'
                  ? new Date(Date.now() + 120_000)
                  : new Date(Date.now() - 1_000),
            })
            .where('workspace_id', '=', workspace.id)
            .where('user_id', '=', guest.userId)
            .execute();
        }
        instant.at = new Date(end.getTime() + 1);
        const publisher = underlying.node(() => undefined, createLogger({ level: 'silent' }));
        await publisher.publish(channelTopic(channelId), {
          event: 'PINS_UPDATED',
          data: { channelId },
          ts: lifetime.now().getTime(),
        });
        await client.until(
          (frames) =>
            frames.some((frame) =>
              change === 'expired'
                ? frame.event === 'ACCESS_REVOKED'
                : frame.event === 'WORKSPACE_UPDATED' && frame.data.accessChanged === true,
            ),
          'current membership at captured expiry',
        );
        const me: unknown = await (await send(guest.cookie, 'GET', '/api/me')).json();
        if (!Value.Check(MeResponse, me)) throw new Error('Invalid expiry account receipt');
        if (change === 'expired') {
          expect(
            me.memberships.some((membership) => membership.workspace.id === workspace.id),
          ).toBe(false);
          expect(
            client.frames
              .filter((frame) => frame.event === 'ACCESS_REVOKED')
              .map((frame) => frame.data.channelIds),
          ).toEqual([[channelId]]);
        } else {
          expect(await client.ended).toBe(CLOSE_CODES.RESYNC);
          expect(client.frames.some((frame) => frame.event === 'ACCESS_REVOKED')).toBe(false);
          expect(
            me.memberships.some((membership) => membership.workspace.id === workspace.id),
          ).toBe(true);
        }
      } finally {
        await client?.close();
        await app.stop(true);
      }
    },
  );

  test.each([
    'scope-removed',
    'membership-removed',
    'shortened-expiry',
    'reactivated',
    'full-readmitted-guest',
  ] as const)(
    'lost control publications do not deliver forbidden words after %s on another publisher',
    async (change) => {
      const shared = inProcessBackplane();
      let dropping = false;
      let dropped = 0;
      const writerBackplane: Backplane = {
        node: (deliver, log, onGap): InspectableEventBus => {
          const bus = shared.node(deliver, log, onGap);
          return {
            ...bus,
            publish: async (topic, frame): Promise<void> => {
              if (
                dropping &&
                ['ACCESS_REVOKED', 'WORKSPACE_UPDATED', 'CHANNELS_UPDATED'].includes(frame.event)
              ) {
                dropped += 1;
                return;
              }
              await bus.publish(topic, frame);
            },
          };
        },
      };
      const config = testConfig({ APP_URL: origin });
      const writer = createApp(
        testDependencies({
          database: cloned.db,
          clock: systemClock,
          config,
          backplane: writerBackplane,
        }),
      );
      const sender = createApp(
        testDependencies({ database: cloned.db, clock: systemClock, config, backplane: shared }),
      );
      writer.listen(0);
      const port = sender.listen(0);
      let client: Client | undefined;
      const request = async (
        app: HttpApplication,
        cookie: string,
        method: string,
        path: string,
        body?: unknown,
      ): Promise<Response> =>
        await app.handle(
          new Request(origin + path, {
            method,
            headers: {
              cookie,
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
      try {
        const owner = await aSignedInUser(cloned.db, systemClock, 'lost-control-owner');
        const guest = await aSignedInUser(cloned.db, systemClock, 'lost-control-guest');
        const account = await cloned.db
          .updateTable('users')
          .set({ email_verified: true })
          .where('id', '=', guest.userId)
          .returning('email')
          .executeTakeFirstOrThrow();
        const makeRoom = async (): Promise<{
          readonly workspaceId: string;
          readonly channelId: string;
        }> => {
          const slug = aUniqueSlug('lost-control');
          const made = await request(writer, owner.cookie, 'POST', '/api/workspaces', {
            name: slug,
            slug,
          });
          expect(made.status).toBe(201);
          const workspace: unknown = await made.json();
          if (!Value.Check(Workspace, workspace))
            throw new Error('Invalid guest workspace fixture');
          const channelId = await theDefaultChannelOf(cloned.db, workspace.id);
          await cloned.db.transaction().execute(async (tx) => {
            const actor = await requireWorkspaceMembership(tx, owner.userId, workspace.id);
            const invitation = await createGuestInvitation(
              tx,
              systemClock,
              actor,
              {
                email: account.email,
                channelIds: [channelId],
                accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
              },
              chatWorkspaceChannels,
            );
            await acceptInvitation(
              tx,
              systemClock,
              guest.userId,
              invitation.token,
              undefined,
              chatWorkspaceChannels,
              true,
            );
          });
          if (change === 'full-readmitted-guest') {
            expect(
              (
                await request(
                  writer,
                  owner.cookie,
                  'POST',
                  `/api/workspaces/${workspace.id}/guests/${guest.userId}/conversion`,
                  { confirmFullAccess: true },
                )
              ).status,
            ).toBe(200);
          }
          return { workspaceId: workspace.id, channelId };
        };
        const target = await makeRoom();
        const control = await makeRoom();
        const say = async (channelId: string, content: string): Promise<string> => {
          const id = messageId(systemClock.now());
          expect(
            (
              await request(sender, owner.cookie, 'POST', `/api/channels/${channelId}/messages`, {
                id,
                content,
              })
            ).status,
          ).toBe(201);
          return id;
        };
        const earlier = await say(target.channelId, 'Previously readable guest words');
        expect(
          (await request(sender, guest.cookie, 'GET', `/api/messages/${earlier}`)).status,
        ).toBe(200);
        client = await connect(guest.cookie, port);
        const ref = messageId(systemClock.now());
        client.send({
          id: ref,
          op: 'SUBSCRIBE',
          payload: {
            channels: [target, control].map(({ channelId }) => ({
              channelId,
              afterMessageId: null,
            })),
          },
        });
        await client.until(
          (frames) => frames.some((frame) => frame.refId === ref && frame.event === 'ACK'),
          'both restricted channels',
        );
        client.frames.length = 0;
        dropping = true;
        const guestPath = `/api/workspaces/${target.workspaceId}/guests/${guest.userId}`;
        if (change === 'scope-removed') {
          expect(
            (await request(writer, owner.cookie, 'PATCH', guestPath, { channelIds: [] })).status,
          ).toBe(200);
        } else if (change === 'membership-removed') {
          expect(
            (
              await request(
                writer,
                owner.cookie,
                'DELETE',
                `/api/workspaces/${target.workspaceId}/members/${guest.userId}`,
              )
            ).status,
          ).toBe(204);
        } else if (change === 'full-readmitted-guest') {
          expect(
            (
              await request(
                writer,
                owner.cookie,
                'DELETE',
                `/api/workspaces/${target.workspaceId}/members/${guest.userId}`,
              )
            ).status,
          ).toBe(204);
          await cloned.db.transaction().execute(async (tx) => {
            const actor = await requireWorkspaceMembership(tx, owner.userId, target.workspaceId);
            const invitation = await createGuestInvitation(
              tx,
              systemClock,
              actor,
              {
                email: account.email,
                channelIds: [target.channelId],
                accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
              },
              chatWorkspaceChannels,
            );
            await acceptInvitation(
              tx,
              systemClock,
              guest.userId,
              invitation.token,
              undefined,
              chatWorkspaceChannels,
              true,
            );
          });
        } else if (change === 'shortened-expiry') {
          const end = new Date(Date.now() + 1500);
          expect(
            (
              await request(writer, owner.cookie, 'PATCH', guestPath, {
                accessExpiresAt: end.toISOString(),
              })
            ).status,
          ).toBe(200);
          while (Date.now() <= end.getTime()) await Bun.sleep(5);
        } else {
          await cloned.db
            .updateTable('workspace_members')
            .set({ guest_expires_at: sql<Date>`statement_timestamp()` })
            .where('workspace_id', '=', target.workspaceId)
            .where('user_id', '=', guest.userId)
            .execute();
          expect(
            (
              await request(writer, owner.cookie, 'PATCH', guestPath, {
                accessExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
              })
            ).status,
          ).toBe(200);
        }
        expect(dropped).toBeGreaterThan(0);
        expect(
          (await request(sender, guest.cookie, 'GET', `/api/messages/${earlier}`)).status,
        ).toBe(404);
        let forbidden: string;
        if (change === 'reactivated' || change === 'full-readmitted-guest') {
          forbidden = earlier;
          expect(
            (
              await request(sender, owner.cookie, 'PATCH', `/api/messages/${earlier}`, {
                content: 'Forbidden earlier words revised after reactivation',
              })
            ).status,
          ).toBe(200);
        } else {
          forbidden = await say(target.channelId, 'Forbidden words after authority ended');
        }
        const healthy = await say(control.channelId, 'Readable ordered control');
        await client.until(
          (frames) =>
            frames.some(
              (frame) =>
                (frame.event === 'MESSAGE_CREATED' && frame.data.id === healthy) ||
                (frame.event === 'WORKSPACE_UPDATED' && frame.data.accessChanged === true),
            ),
          'ordered restricted control or policy resync',
        );
        expect(
          client.frames.some(
            (frame) =>
              (frame.event === 'MESSAGE_CREATED' && frame.data.id === forbidden) ||
              (frame.event === 'MESSAGE_REVISED' && frame.data.messageId === forbidden),
          ),
        ).toBe(false);
        if (change === 'reactivated' || change === 'full-readmitted-guest') {
          expect(
            client.frames.some(
              (frame) => frame.event === 'WORKSPACE_UPDATED' && frame.data.accessChanged === true,
            ),
          ).toBe(true);
          expect(await client.ended).toBe(CLOSE_CODES.RESYNC);
        } else {
          expect(created(client.frames)).toContain(healthy);
        }
      } finally {
        await client?.close();
        await sender.stop(true);
        await writer.stop(true);
      }
    },
  );

  test('an edited earlier message is hidden while a new message still reaches the guest on another node', async () => {
    const room = await aRoom();
    const earlier = await post(room.alice.cookie, room.channelId, -1_000);
    await cloned.db
      .updateTable('messages')
      .set({ created_at: new Date(NOW.getTime() - 60_000) })
      .where('id', '=', earlier)
      .execute();
    await cloned.db
      .updateTable('workspace_members')
      .set({
        access_kind: 'guest',
        guest_since: new Date(NOW.getTime() - 1_000),
        guest_modules: ['chat'],
      })
      .where('workspace_id', '=', room.workspaceId)
      .where('user_id', '=', room.bob.userId)
      .execute();
    const guest = await connect(room.bob.cookie);
    const owner = await connect(room.alice.cookie);
    try {
      await subscribe(guest, room.channelId);
      await subscribe(owner, room.channelId);
      expect(guest.frames.some((frame) => frame.event === 'ACK' && 'channels' in frame.data)).toBe(
        true,
      );
      expect((await http('GET', `/api/messages/${earlier}`, room.bob.cookie)).status).toBe(404);
      expect(
        (
          await http('PATCH', `/api/messages/${earlier}`, room.alice.cookie, {
            content: 'Earlier confidential words',
          })
        ).ok,
      ).toBe(true);
      const later = await post(room.alice.cookie, room.channelId, 1);
      // A later accepted channel frame is the barrier for the guest's ordered, asynchronous projection.
      await guest.until((frames) => created(frames).includes(later), 'the later guest message');
      await owner.until(
        (frames) =>
          frames.some(
            (frame) => frame.event === 'MESSAGE_REVISED' && frame.data.messageId === earlier,
          ),
        'the owner’s earlier revision',
      );
      expect(
        guest.frames.some(
          (frame) => frame.event === 'MESSAGE_REVISED' && frame.data.messageId === earlier,
        ),
      ).toBe(false);
    } finally {
      await guest.close();
      await owner.close();
    }
  });
});

describe('integration: a session that ends on another node', () => {
  test('signing out on node A closes the socket node B holds, after saying why', async () => {
    const alice = await aSignedInUser(cloned.db, clock, 'signout');
    const socket = await connect(alice.cookie);

    expect((await http('POST', '/auth/logout', alice.cookie)).status).toBe(204);

    expect(await socket.ended).toBe(CLOSE_CODES.SESSION_ENDED);
    // A person hears their own presence (D-257); the only other word is why the socket closes.
    expect(socket.frames.filter((f) => f.event !== 'PRESENCE')).toMatchObject([
      { event: 'SESSION_ENDED', data: { reason: 'signed-out' } },
    ]);
  });

  test('a deleted user’s sockets close, whichever node holds them', async () => {
    const alice = await aSignedInUser(cloned.db, clock, 'deleted');
    const bystander = await aSignedInUser(cloned.db, clock, 'bystander');
    const socket = await connect(alice.cookie);
    const other = await connect(bystander.cookie);

    await publishUserDeleted(publisher, clock, alice.userId);

    expect(await socket.ended).toBe(CLOSE_CODES.SESSION_ENDED);
    expect(socket.frames.filter((f) => f.event !== 'PRESENCE')).toMatchObject([
      { event: 'SESSION_ENDED', data: { reason: 'account-deleted' } },
    ]);
    // The control: the same publish left someone else's socket open and usable.
    await settle(other);
    expect(other.frames.some((f) => f.event === 'SESSION_ENDED')).toBe(false);
    await other.close();
  });
});

describe('integration: a workspace renamed (D-124)', () => {
  test('renamed on one node, each member’s socket on another is told; a stranger’s and a removed member’s are not', async () => {
    const room = await aRoom();
    const carol = await aSignedInUser(cloned.db, clock, 'carol');
    const dave = await aSignedInUser(cloned.db, clock, 'dave');
    await cloned.db
      .insertInto('workspace_members')
      .values({
        workspace_id: room.workspaceId,
        user_id: dave.userId,
        role: 'member',
        joined_at: NOW,
      })
      .execute();
    const bob = await connect(room.bob.cookie);
    const stranger = await connect(carol.cookie);
    const removed = await connect(dave.cookie);
    await settle(bob);
    await settle(stranger);
    await settle(removed);
    expect(
      (
        await http(
          'DELETE',
          `/api/workspaces/${room.workspaceId}/members/${dave.userId}`,
          room.alice.cookie,
        )
      ).status,
    ).toBe(204);

    const renamed = await http('PATCH', `/api/workspaces/${room.workspaceId}`, room.alice.cookie, {
      name: 'renamed across nodes',
    });
    expect(renamed.status).toBe(200);
    await bob.until(
      (frames) => frames.some((f) => f.event === 'WORKSPACE_UPDATED'),
      'the notice of the rename',
    );
    expect(bob.frames.find((f) => f.event === 'WORKSPACE_UPDATED')?.data).toEqual({
      workspaceId: room.workspaceId,
    });
    await settle(stranger);
    await settle(removed);
    expect(stranger.frames.some((f) => f.event === 'WORKSPACE_UPDATED')).toBe(false);
    expect(removed.frames.some((f) => f.event === 'WORKSPACE_UPDATED')).toBe(false);
    await bob.close();
    await stranger.close();
    await removed.close();
  });
});

describe('integration: a workspace whose deletion is asked for (D-242)', () => {
  test('every member’s socket on another node stops its channels and is told; it stays open, and taken back it is told again', async () => {
    const room = await aRoom();
    const name = (
      (await (
        await http('GET', `/api/workspaces/${room.workspaceId}`, room.alice.cookie)
      ).json()) as {
        name: string;
      }
    ).name;
    const bob = await connect(room.bob.cookie);
    await subscribe(bob, room.channelId);
    const before = await post(room.alice.cookie, room.channelId, 21);
    await bob.until((frames) => created(frames).includes(before), 'the message before');

    const asked = await http(
      'POST',
      `/api/workspaces/${room.workspaceId}/deletion`,
      room.alice.cookie,
      {
        confirm: name,
      },
    );
    expect(asked.status).toBe(200);
    await bob.until(
      (frames) =>
        frames.some((f) => f.event === 'ACCESS_REVOKED') &&
        frames.some((f) => f.event === 'WORKSPACE_UPDATED'),
      'the notices of the deletion',
    );
    expect(bob.frames.find((f) => f.event === 'ACCESS_REVOKED')?.data).toEqual({
      channelIds: [room.channelId],
    });
    expect(bob.frames.find((f) => f.event === 'WORKSPACE_UPDATED')?.data).toEqual({
      workspaceId: room.workspaceId,
    });
    // Open, and the session good: it answers, and subscribing to the channel again is refused.
    await settle(bob);
    const id = messageId(new Date(NOW.getTime() + 22));
    bob.send({
      id,
      op: 'SUBSCRIBE',
      payload: { channels: [{ channelId: room.channelId, afterMessageId: null }] },
    });
    await bob.until((frames) => frames.some((f) => f.refId === id), 'the refused subscription');
    expect(bob.frames.find((f) => f.refId === id)?.event).toBe('ERROR');

    const updates = (): number => bob.frames.filter((f) => f.event === 'WORKSPACE_UPDATED').length;
    expect(
      (await http('DELETE', `/api/workspaces/${room.workspaceId}/deletion`, room.alice.cookie))
        .status,
    ).toBe(204);
    await bob.until(() => updates() === 2, 'the notice that it is back');
    await bob.close();
  });
});

describe('integration: a membership that ends', () => {
  test('removing a member stops the channel on the socket, which stays open', async () => {
    const room = await aRoom();
    const bob = await connect(room.bob.cookie);
    await subscribe(bob, room.channelId);

    // The control: subscribed, Bob receives what Alice posts.
    const before = await post(room.alice.cookie, room.channelId, 1);
    await bob.until((frames) => created(frames).includes(before), 'the message before removal');

    // Removed the way Phase 1's endpoint will: the rows go, then the event is published.
    await cloned.db
      .deleteFrom('channel_members')
      .where('channel_id', '=', room.channelId)
      .where('user_id', '=', room.bob.userId)
      .execute();
    await cloned.db
      .deleteFrom('workspace_members')
      .where('workspace_id', '=', room.workspaceId)
      .where('user_id', '=', room.bob.userId)
      .execute();
    expect((await http('GET', `/api/channels/${room.channelId}`, room.bob.cookie)).status).toBe(
      404,
    );
    await publishAccessRevoked(publisher, clock, room.bob.userId, [room.channelId]);
    await bob.until(
      (frames) => frames.some((f) => f.event === 'ACCESS_REVOKED'),
      'the notice of the removal',
    );

    await post(room.alice.cookie, room.channelId, 2);
    await settle(bob);
    expect(created(bob.frames)).toEqual([before]);
    expect(bob.frames.find((f) => f.event === 'ACCESS_REVOKED')?.data).toEqual({
      channelIds: [room.channelId],
    });
    await bob.close();
  });

  test('removed through the endpoint on one node, the member’s socket on another is told and stops (#51)', async () => {
    const room = await aRoom();
    const bob = await connect(room.bob.cookie);
    await subscribe(bob, room.channelId);
    const before = await post(room.alice.cookie, room.channelId, 1);
    await bob.until((frames) => created(frames).includes(before), 'the message before');

    const removed = await http(
      'DELETE',
      `/api/workspaces/${room.workspaceId}/members/${room.bob.userId}`,
      room.alice.cookie,
    );
    expect(removed.status).toBe(204);
    await bob.until(
      (frames) => frames.some((f) => f.event === 'ACCESS_REVOKED'),
      'the notice of the removal',
    );
    // Every channel the workspace showed him: his, and the public one it started with (D-174).
    const revoked = bob.frames.find((f) => f.event === 'ACCESS_REVOKED');
    expect(
      revoked?.event === 'ACCESS_REVOKED' ? [...revoked.data.channelIds].sort() : null,
    ).toEqual([room.channelId, await theDefaultChannelOf(cloned.db, room.workspaceId)].sort());
    await post(room.alice.cookie, room.channelId, 2);
    await settle(bob);
    expect(created(bob.frames)).toEqual([before]);
    expect((await http('GET', `/api/workspaces/${room.workspaceId}`, room.bob.cookie)).status).toBe(
      404,
    );
    await bob.close();
  });

  test('leaving one channel stops that channel and keeps the others on the same socket', async () => {
    const room = await aRoom();
    const second = (await (
      await http('POST', `/api/workspaces/${room.workspaceId}/channels`, room.alice.cookie, {
        name: 'random',
      })
    ).json()) as { id: string };
    expect((await http('POST', `/api/channels/${second.id}/join`, room.bob.cookie)).ok).toBe(true);
    const bob = await connect(room.bob.cookie);
    await subscribe(bob, room.channelId);
    await subscribe(bob, second.id);

    await cloned.db
      .deleteFrom('channel_members')
      .where('channel_id', '=', room.channelId)
      .where('user_id', '=', room.bob.userId)
      .execute();
    await publishAccessRevoked(publisher, clock, room.bob.userId, [room.channelId]);
    await bob.until((frames) => frames.some((f) => f.event === 'ACCESS_REVOKED'), 'the notice');

    await post(room.alice.cookie, room.channelId, 5);
    const kept = await post(room.alice.cookie, second.id, 6);
    await settle(bob);
    // Only the channel Bob kept; the same socket, still open.
    expect(created(bob.frames)).toEqual([kept]);
    await bob.close();
  });

  test('deleting a channel stops it for everyone watching it', async () => {
    const room = await aRoom();
    const alice = await connect(room.alice.cookie);
    const bob = await connect(room.bob.cookie);
    await subscribe(alice, room.channelId);
    await subscribe(bob, room.channelId);

    await publishChannelRevoked(publisher, clock, room.channelId);
    await alice.until((frames) => frames.some((f) => f.event === 'ACCESS_REVOKED'), 'the notice');
    await bob.until((frames) => frames.some((f) => f.event === 'ACCESS_REVOKED'), 'the notice');

    await post(room.alice.cookie, room.channelId, 3);
    await settle(alice);
    await settle(bob);
    expect(created(alice.frames)).toEqual([]);
    expect(created(bob.frames)).toEqual([]);
    await alice.close();
    await bob.close();
  });

  /**
   * The race the subscribe-first order exists for: the removal is published while
   * the subscription's authorisation is being read, which happened before the rows
   * went. Subscribed only after that read, the socket would find the revocation
   * already past and keep the channel for good.
   */
  const removalDuringAuthorisation = async (
    presenceFirst = false,
    presenceInFlight = false,
  ): Promise<void> => {
    const room = await aRoom();
    const bob = await connect(room.bob.cookie);
    // Its identity is resolved by a read of its own; let that finish.
    await settle(bob);

    const announce = async (): Promise<void> => {
      await announcePresence(
        { database: nodeBDatabase, bus: publisher, clock, log: createLogger({ level: 'silent' }) },
        { userId: room.bob.userId, online: true, away: false, version: 1 },
      );
    };
    const reached = Promise.withResolvers<undefined>();
    const resume = Promise.withResolvers<undefined>();
    let presence: Promise<void> | undefined;
    try {
      if (presenceInFlight) {
        beforePresenceResult = async (): Promise<void> => {
          reached.resolve(undefined);
          await resume.promise;
        };
        presence = announce();
        await reached.promise;
      }
      authorisationChannelId = room.channelId;
      duringAuthorisation = async (): Promise<void> => {
        await publishAccessRevoked(publisher, clock, room.bob.userId, [room.channelId]);
      };
      if (presenceFirst) {
        // A genuine presence read contains a nested channel-membership query. Complete it after
        // arming the hook, before SUBSCRIBE: it must not spend the authorization interception.
        await announce();
        expect(duringAuthorisation).toBeDefined();
      }
      await subscribe(bob, room.channelId);
      expect(duringAuthorisation).toBeUndefined();
    } finally {
      resume.resolve(undefined);
      beforePresenceResult = undefined;
      await presence;
      authorisationChannelId = undefined;
      duringAuthorisation = undefined;
    }

    await post(room.alice.cookie, room.channelId, 4);
    await settle(bob);
    expect(created(bob.frames)).toEqual([]);
    expect(bob.frames.some((f) => f.event === 'ACCESS_REVOKED')).toBe(true);
    await bob.close();
  };

  test('a removal published while a subscription is being authorised still ends it', async () => {
    await removalDuringAuthorisation();
  });

  test('a presence read finishing before subscription cannot consume its authorization interception', async () => {
    await removalDuringAuthorisation(true);
  });

  test('and so does one while a read of the socket’s own is still in flight', async () => {
    await removalDuringAuthorisation(false, true);
  });
});
