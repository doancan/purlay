/**
 * Who is responding to an incident (#487, D-137 §3): members of its channel, brought in and taken off
 * by anyone in it — themselves included — at most `INCIDENT_RESPONDERS_MAX`.
 *
 * - **Somebody not in the channel cannot be brought in**: one answer for a stranger, another
 *   workspace's person and a workspace member not in this channel (`404 USER_NOT_FOUND`, which says
 *   nothing of which). Somebody who leaves afterwards stays on the list: who responded is a record of
 *   the incident, as a message stays its author's — and nothing changes silently under the others.
 * - **Idempotent**: bringing in somebody already responding, or taking off somebody who is not, changes
 *   nothing and tells nobody.
 * - **Still kept after the incident is resolved**: who worked on it is part of what is written up
 *   afterwards, as the postmortem is; only its status and severity are fixed once resolved.
 * - **On the timeline**, each change with who made it, under the incident's row lock.
 */
import { Value } from '@sinclair/typebox/value';
import type { Transaction } from '@purlay/db';
import { INCIDENT_RESPONDERS_MAX, Uuid } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import type { ChannelContext } from '../../platform/channels';
import { AppError } from '../../platform/errors';
import {
  incidentNotFound,
  record,
  requireWriter,
  unchanged,
  type IncidentWrite,
} from './incidents';

const personNotFound = (): AppError =>
  new AppError({ code: 'USER_NOT_FOUND', message: 'There is nobody by that id in this channel.' });

/** The incident is this channel's, locked for the change: two at once are one after the other. */
const lockIncident = async (
  executor: Transaction,
  context: ChannelContext,
  incidentId: string,
): Promise<void> => {
  if (!Value.Check(Uuid, incidentId)) throw incidentNotFound();
  const row = await executor
    .selectFrom('incidents')
    .select('id')
    .where('id', '=', incidentId)
    .where('channel_id', '=', context.channelId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (row === undefined) throw incidentNotFound();
};

/** Brings somebody in the channel in to respond; already responding, they are left as they were. */
export const addResponder = async (
  executor: Transaction,
  clock: Clock,
  context: ChannelContext,
  incidentId: string,
  userId: string,
): Promise<IncidentWrite> => {
  await requireWriter(executor, context);
  await lockIncident(executor, context, incidentId);
  if (!Value.Check(Uuid, userId)) throw personNotFound();
  const member = await executor
    .selectFrom('channel_members')
    .select('user_id')
    .where('channel_id', '=', context.channelId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (member === undefined) throw personNotFound();
  const already = await executor
    .selectFrom('incident_responders')
    .select('user_id')
    .where('incident_id', '=', incidentId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (already !== undefined) return await unchanged(executor, incidentId);
  const counted = await executor
    .selectFrom('incident_responders')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('incident_id', '=', incidentId)
    .executeTakeFirstOrThrow();
  if (Number(counted.count) >= INCIDENT_RESPONDERS_MAX) {
    throw new AppError({
      code: 'INCIDENT_RESPONDERS_LIMIT',
      message: `At most ${String(INCIDENT_RESPONDERS_MAX)} people respond to one incident.`,
    });
  }
  const now = clock.now();
  // After the last brought in, whatever the clock says: two in one millisecond still list in the
  // order they were brought in. The incident's row lock makes this read the last.
  const last = await executor
    .selectFrom('incident_responders')
    .select((eb) => eb.fn.max('added_at').as('at'))
    .where('incident_id', '=', incidentId)
    .executeTakeFirst();
  const lastAt = last?.at == null ? null : new Date(last.at).getTime();
  await executor
    .insertInto('incident_responders')
    .values({
      incident_id: incidentId,
      channel_id: context.channelId,
      user_id: userId,
      added_by: context.userId,
      added_at: lastAt === null ? now : new Date(Math.max(now.getTime(), lastAt + 1)),
    })
    .execute();
  await record(executor, incidentId, context.userId, now, {
    kind: 'responder_added',
    from: null,
    to: userId,
  });
  return { ...(await unchanged(executor, incidentId)), changed: true };
};

/** Takes somebody off; not responding, nothing changes. */
export const removeResponder = async (
  executor: Transaction,
  clock: Clock,
  context: ChannelContext,
  incidentId: string,
  userId: string,
): Promise<IncidentWrite> => {
  await requireWriter(executor, context);
  await lockIncident(executor, context, incidentId);
  if (!Value.Check(Uuid, userId)) throw personNotFound();
  const removed = await executor
    .deleteFrom('incident_responders')
    .where('incident_id', '=', incidentId)
    .where('user_id', '=', userId)
    .executeTakeFirst();
  if (removed.numDeletedRows === 0n) return await unchanged(executor, incidentId);
  await record(executor, incidentId, context.userId, clock.now(), {
    kind: 'responder_removed',
    from: null,
    to: userId,
  });
  return { ...(await unchanged(executor, incidentId)), changed: true };
};
