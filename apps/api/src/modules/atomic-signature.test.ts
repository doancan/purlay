/**
 * A service that writes twice cannot be handed the pool (#232).
 *
 * The assertion is at compile time: `@ts-expect-error` fails the build if the
 * line beneath it ever starts to compile. The functions are never called — what
 * is being checked is the signature, and calling them would need a database.
 */
import { describe, expect, test } from 'bun:test';
import type { Executor, Transaction } from '@purlay/db';
import { fixedClock } from '../platform/clock';
import type { WorkspaceContext } from '../platform/tenancy';
import { createChannel } from './channels/channels';
import { createWorkspace } from './workspaces/workspaces';
import { acceptInvitation, createInvitation, revokeInvitation } from './workspaces/invitations';

const clock = fixedClock(new Date('2026-09-09T12:00:00.000Z'));

describe('multi-write services take a transaction', () => {
  test('the pool is refused by the type, a transaction is accepted', () => {
    const workspaceFromPool = async (pool: Executor): Promise<unknown> =>
      // @ts-expect-error — this must not compile: the pool is not a transaction.
      await createWorkspace(pool, clock, 'user', { name: 'n', slug: 's' });
    const channelFromPool = async (pool: Executor, context: WorkspaceContext): Promise<unknown> =>
      // @ts-expect-error — this must not compile: the pool is not a transaction.
      await createChannel(pool, clock, context, { name: 'n' });
    const invitationFromPool = async (
      pool: Executor,
      context: WorkspaceContext,
    ): Promise<unknown> =>
      // @ts-expect-error — this must not compile: the pool is not a transaction.
      await createInvitation(pool, clock, context);
    const revocationFromPool = async (pool: Executor, context: WorkspaceContext): Promise<void> => {
      // @ts-expect-error — this must not compile: the pool is not a transaction.
      await revokeInvitation(pool, clock, context, 'invitation');
    };
    const joinFromPool = async (pool: Executor): Promise<unknown> =>
      // @ts-expect-error — this must not compile: the pool is not a transaction.
      await acceptInvitation(pool, clock, 'user', 'token');
    const fromTransaction = async (transaction: Transaction): Promise<unknown> =>
      await createWorkspace(transaction, clock, 'user', { name: 'n', slug: 's' });

    expect([
      workspaceFromPool,
      channelFromPool,
      invitationFromPool,
      revocationFromPool,
      joinFromPool,
      fromTransaction,
    ]).toHaveLength(6);
  });
});
