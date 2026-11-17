/** Current authority wins, or waits for the webhook transaction; a context is never authority (D-245, D-312). */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  sql,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  type ClonedDatabase,
  type Transaction,
} from '@purlay/db';
import { requireChannelById, type ChannelContext } from '../channels/guard';
import { removeChannelMember } from '../channels/settings';
import { changeRole } from '../../../modules/workspaces/members';
import { fixedClock } from '../../../platform/clock';
import { credentialCipher } from '../../../platform/crypto';
import { AppError } from '../../../platform/errors';
import { requireWorkspaceMembership, type WorkspaceContext } from '../../../platform/tenancy';
import { aRoom } from '../../../testing/rooms';
import { testConfig } from '../../../testing/doubles';
import { createWebhook } from './incoming-webhooks';
import { createOutgoingWebhook } from './outgoing-webhooks';

let cloned: ClonedDatabase;
const clock = fixedClock(new Date('2026-11-17T12:00:00Z'));
const cipher = credentialCipher(testConfig().ENCRYPTION_KEY);
beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);
afterAll(async () => {
  await cloned.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

type Direction = 'incoming' | 'outgoing';
type Change = 'demotion' | 'private removal';
interface Receipt {
  readonly id: string;
  readonly credential: string;
}
interface Actors {
  readonly owner: ChannelContext;
  readonly workspaceOwner: WorkspaceContext;
  readonly admin: ChannelContext;
}
const actors = async (): Promise<Actors> => {
  const room = await aRoom(cloned.db, ['owner', 'admin'], { type: 'private' });
  const owner = room.members['owner']?.context;
  const userId = room.members['admin']?.userId;
  if (owner === undefined || userId === undefined) throw new Error('missing actors');
  const workspaceOwner = await requireWorkspaceMembership(
    cloned.db,
    owner.userId,
    room.workspaceId,
  );
  await cloned.db.transaction().execute(async (tx) => {
    await changeRole(tx, clock, workspaceOwner, userId, 'admin');
  });
  return {
    owner,
    workspaceOwner,
    admin: await requireChannelById(cloned.db, userId, room.channelId),
  };
};
const create = async (
  tx: Transaction,
  direction: Direction,
  context: ChannelContext,
): Promise<Receipt> => {
  if (direction === 'incoming') {
    const made = await createWebhook(tx, clock, context, { name: 'Authority proof' });
    return { id: made.webhook.id, credential: made.path };
  }
  const made = await createOutgoingWebhook(tx, clock, cipher, context, {
    name: 'Authority proof',
    url: 'https://example.com/hook',
    events: ['message.created'],
  });
  return { id: made.webhook.id, credential: made.secret };
};
const change = async (
  tx: Transaction,
  which: Change,
  { owner, workspaceOwner, admin }: Actors,
): Promise<void> => {
  if (which === 'demotion') await changeRole(tx, clock, workspaceOwner, admin.userId, 'member');
  else expect(await removeChannelMember(tx, clock, owner, admin.userId)).toBe('removed');
};
const pid = async (tx: Transaction, name: string): Promise<number> => {
  const { rows } = await sql<{ pid: number }>`select pg_backend_pid() as pid,
    set_config('application_name', ${name}, true)`.execute(tx);
  const result = rows[0]?.pid;
  if (result === undefined) throw new Error('missing backend');
  return result;
};
/** Observe the particular wait edge, never an unrelated waiter or a timing guess. */
const waitsFor = async (name: string, blocker: number, table = ''): Promise<number | undefined> => {
  for (let look = 0; look < 500; look++) {
    const { rows } = await sql<{ pid: number }>`select pid from pg_stat_activity
      where datname = current_database() and application_name = ${name}
      and ${blocker} = any(pg_blocking_pids(pid))
      and position(${table} in query) > 0`.execute(cloned.db);
    if (rows[0] !== undefined) return rows[0].pid;
  }
  return undefined;
};
const outcome = async (work: Promise<unknown>): Promise<string> =>
  await work.then(
    () => 'done',
    (error: unknown) => (error instanceof AppError ? error.body.code : String(error)),
  );
/** A failed transaction must fail setup immediately rather than leave a latch pending until timeout. */
const untilReady = async <T>(ready: Promise<T>, work: Promise<string>): Promise<T> =>
  await Promise.race([
    ready,
    work.then((result) => {
      throw new Error(`transaction ended before its checkpoint: ${result}`);
    }),
  ]);
const written = async (direction: Direction, admin: ChannelContext): Promise<unknown> => {
  const hooks = await cloned.db
    .selectFrom(direction === 'incoming' ? 'incoming_webhooks' : 'outgoing_webhooks')
    .select('id')
    .where('channel_id', '=', admin.channelId)
    .execute();
  const audit = await cloned.db
    .selectFrom('audit_log')
    .select('target_id')
    .where('workspace_id', '=', admin.workspaceId)
    .where('actor_user_id', '=', admin.userId)
    .where(
      'action',
      '=',
      direction === 'incoming'
        ? 'integration.webhook_created'
        : 'integration.outgoing_webhook_changed',
    )
    .execute();
  return { hooks, audit };
};

describe('integration: webhook creation holds current authority', () => {
  for (const direction of ['incoming', 'outgoing'] as const) {
    describe(`integration: ${direction} webhook creation and current authority`, () => {
      for (const which of ['demotion', 'private removal'] as const) {
        test(`${which} wins: a stale admin context returns no credential, hook or audit`, async () => {
          const people = await actors();
          const ready = Promise.withResolvers<number>();
          const release = Promise.withResolvers<undefined>();
          let receipt: Receipt | undefined;
          const authority = outcome(
            cloned.db.transaction().execute(async (tx) => {
              const backend = await pid(tx, 'webhook-authority-winner');
              await change(tx, which, people);
              ready.resolve(backend);
              await release.promise;
            }),
          );
          let creating: Promise<string> | undefined;
          try {
            const backend = await untilReady(ready.promise, authority);
            creating = outcome(
              cloned.db.transaction().execute(async (tx) => {
                await pid(tx, 'webhook-create-loser');
                receipt = await create(tx, direction, people.admin);
              }),
            );
            expect(await waitsFor('webhook-create-loser', backend)).toBeDefined();
          } finally {
            release.resolve(undefined);
            const [changed, made] = await Promise.all([authority, creating]);
            expect(changed).toBe('done');
            if (creating !== undefined)
              expect(made).toBe(which === 'demotion' ? 'FORBIDDEN' : 'CHANNEL_NOT_FOUND');
          }
          expect(receipt).toBeUndefined();
          expect(await written(direction, people.admin)).toEqual({ hooks: [], audit: [] });
        });

        test(`create waits at channel admission: ${which} cannot pass its authority locks`, async () => {
          const people = await actors();
          const channelReady = Promise.withResolvers<number>();
          const releaseChannel = Promise.withResolvers<undefined>();
          const created = Promise.withResolvers<Receipt>();
          const releaseCreate = Promise.withResolvers<undefined>();
          const holder = outcome(
            cloned.db.transaction().execute(async (tx) => {
              const backend = await pid(tx, 'webhook-channel-holder');
              await tx
                .selectFrom('channels')
                .select('id')
                .where('id', '=', people.admin.channelId)
                .forNoKeyUpdate()
                .execute();
              channelReady.resolve(backend);
              await releaseChannel.promise;
            }),
          );
          let creating: Promise<string> | undefined;
          let authority: Promise<string> | undefined;
          try {
            const backend = await untilReady(channelReady.promise, holder);
            creating = outcome(
              cloned.db.transaction().execute(async (tx) => {
                await pid(tx, 'webhook-create-winner');
                created.resolve(await create(tx, direction, people.admin));
                await releaseCreate.promise;
              }),
            );
            const creator = await waitsFor('webhook-create-winner', backend);
            expect(creator).toBeDefined();
            if (creator === undefined) throw new Error('create did not wait at channel admission');
            authority = outcome(
              cloned.db.transaction().execute(async (tx) => {
                await pid(tx, 'webhook-authority-loser');
                await change(tx, which, people);
              }),
            );
            expect(
              await waitsFor(
                'webhook-authority-loser',
                creator,
                which === 'demotion' ? 'workspaces' : 'channel_members',
              ),
            ).toBeDefined();
            releaseChannel.resolve(undefined);
            expect(await holder).toBe('done');
            const receipt = await untilReady(created.promise, creating);
            expect(receipt.credential.length).toBeGreaterThan(32);
            // Keep create uncommitted: removal/demotion must still be waiting on this exact backend.
            expect(
              await waitsFor(
                'webhook-authority-loser',
                creator,
                which === 'demotion' ? 'workspaces' : 'channel_members',
              ),
            ).toBeDefined();
            releaseCreate.resolve(undefined);
            expect(await creating).toBe('done');
            expect(await authority).toBe('done');
            expect(await written(direction, people.admin)).toEqual({
              hooks: [{ id: receipt.id }],
              audit: [{ target_id: receipt.id }],
            });
            // Once the authority change commits even the previously successful caller cannot create again.
            expect(
              await outcome(
                cloned.db
                  .transaction()
                  .execute(async (tx) => await create(tx, direction, people.admin)),
              ),
            ).toBe(which === 'demotion' ? 'FORBIDDEN' : 'CHANNEL_NOT_FOUND');
            expect(await written(direction, people.admin)).toEqual({
              hooks: [{ id: receipt.id }],
              audit: [{ target_id: receipt.id }],
            });
          } finally {
            releaseChannel.resolve(undefined);
            releaseCreate.resolve(undefined);
            await Promise.all([holder, creating, authority]);
          }
        });
      }
    });
  }
});
