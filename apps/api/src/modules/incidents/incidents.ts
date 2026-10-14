/**
 * A channel's incidents (#487, D-137): an incident is a state of a channel, not a kind of channel.
 *
 * - **Anyone in the channel declares, moves and resolves it.** Seeing a public channel is not being
 *   in it (`403`), as for renaming it (D-123 §1); a direct message has none (`404`, as starring).
 * - **One open a channel**, held by `idx_incidents_one_open`: the service's check gives the good
 *   error, and the index makes a race lose the same way.
 * - **A declaration is idempotent on its id**, the client's UUIDv7 (D-33): the same id in this channel
 *   at this severity answers the incident it made; any other use of the id is a conflict that says
 *   nothing of where it was used.
 * - **The last change wins** (D-137 §5): status and severity change without a version, and asking for
 *   what is already there changes nothing and tells nobody. Resolved is once and for good.
 * - **Every change is on its timeline**, in the same transaction, with who and when; the id is after
 *   the newest whatever the clock says, so the order is the order they were made.
 */
import { Value } from '@sinclair/typebox/value';
import type { Executor, Transaction } from '@purlay/db';
import {
  Uuid,
  isMessageIdShape,
  messageId,
  messageIdTime,
  type ChangeIncidentRequest,
  type DeclareIncidentRequest,
  type Incident,
  type IncidentChange,
  type IncidentSeverity,
  type User,
  type IncidentStatus,
  type IncidentUpdatePage,
  type OpenIncidentStatus,
  type OlderPageQuery,
} from '@purlay/types';
import type { Clock } from '../../platform/clock';
import {
  channelNotFound,
  requireChannelMember,
  type ChannelContext,
} from '../../platform/channels';
import { AppError } from '../../platform/errors';
import { limitOf } from '../messages/threads';

const at = (value: Date | string): string => new Date(value).toISOString();

export const incidentNotFound = (): AppError =>
  new AppError({ code: 'INCIDENT_NOT_FOUND', message: 'Incident not found.' });

/** What a change did: the channel it is in, and whether anything changed there to tell. */
export interface IncidentWrite {
  readonly incident: Incident;
  readonly changed: boolean;
}

interface IncidentRow {
  readonly id: string;
  readonly channel_id: string;
  readonly severity: number;
  readonly status: string;
  readonly declared_at: Date | string;
  readonly resolved_at: Date | string | null;
  readonly declarer_id: string | null;
  readonly declarer_username: string | null;
  readonly declarer_display_name: string | null;
  readonly declarer_avatar_url: string | null;
  readonly declarer_deleted_at: Date | string | null;
}

/** A value the table's CHECKs hold, read as the contract names it — or loudly not. */
const severityOf = (value: number | string): IncidentSeverity => {
  const severity = Number(value);
  if (severity === 1 || severity === 2 || severity === 3 || severity === 4) return severity;
  throw new Error(`an incident's severity is ${String(value)}`);
};

const openStatusOf = (value: string): OpenIncidentStatus => {
  if (value === 'investigating' || value === 'mitigating') return value;
  throw new Error(`an open incident's status is ${value}`);
};

const statusOf = (value: string): IncidentStatus =>
  value === 'resolved' ? value : openStatusOf(value);

/** A person as the contract shows one: null when the row is gone, the id alone once erased (I-11). */
const personOf = (row: {
  readonly id: string | null;
  readonly username: string | null;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
  readonly deletedAt: Date | string | null;
}): User | null =>
  row.id === null || row.username === null || row.displayName === null
    ? null
    : row.deletedAt !== null
      ? { id: row.id, username: 'deleted', displayName: 'Deleted user', avatarUrl: null }
      : {
          id: row.id,
          username: row.username,
          displayName: row.displayName,
          avatarUrl: row.avatarUrl,
        };

const asIncident = (row: IncidentRow, responders: readonly User[]): Incident => {
  const fields = {
    id: row.id,
    channelId: row.channel_id,
    severity: severityOf(row.severity),
    declaredBy: personOf({
      id: row.declarer_id,
      username: row.declarer_username,
      displayName: row.declarer_display_name,
      avatarUrl: row.declarer_avatar_url,
      deletedAt: row.declarer_deleted_at,
    }),
    declaredAt: at(row.declared_at),
    responders: [...responders],
  };
  // One fact, read as one: the table holds status and instant together (`incidents_resolved_at`).
  if (row.status === 'resolved') {
    if (row.resolved_at === null) throw new Error(`incident ${row.id} is resolved with no instant`);
    return { ...fields, status: 'resolved', resolvedAt: at(row.resolved_at) };
  }
  if (row.resolved_at !== null) throw new Error(`incident ${row.id} is open with an instant`);
  return { ...fields, status: openStatusOf(row.status), resolvedAt: null };
};

/**
 * One incident with who declared it: by its id, or a channel's open one — or once none is open, its
 * latest (`NULLS FIRST` under `DESC` is PostgreSQL's own order, said out loud).
 */
const findIncident = async (
  executor: Executor,
  by: { readonly id: string } | { readonly channelId: string },
): Promise<IncidentRow | undefined> => {
  const query = executor
    .selectFrom('incidents')
    .leftJoin('users', 'users.id', 'incidents.declared_by')
    .select([
      'incidents.id as id',
      'incidents.channel_id as channel_id',
      'incidents.severity as severity',
      'incidents.status as status',
      'incidents.declared_at as declared_at',
      'incidents.resolved_at as resolved_at',
      'users.id as declarer_id',
      'users.username as declarer_username',
      'users.display_name as declarer_display_name',
      'users.avatar_url as declarer_avatar_url',
      'users.deleted_at as declarer_deleted_at',
    ]);
  if ('id' in by) return await query.where('incidents.id', '=', by.id).executeTakeFirst();
  return await query
    .where('incidents.channel_id', '=', by.channelId)
    .orderBy('incidents.resolved_at', (order) => order.desc().nullsFirst())
    .orderBy('incidents.declared_at', 'desc')
    .orderBy('incidents.id', 'desc')
    .limit(1)
    .executeTakeFirst();
};

/** Who is responding to it, first brought in first. Bounded by `INCIDENT_RESPONDERS_MAX`. */
const respondersOf = async (executor: Executor, incidentId: string): Promise<readonly User[]> => {
  const rows = await executor
    .selectFrom('incident_responders')
    .innerJoin('users', 'users.id', 'incident_responders.user_id')
    .select([
      'users.id as id',
      'users.username as username',
      'users.display_name as displayName',
      'users.avatar_url as avatarUrl',
      'users.deleted_at as deletedAt',
    ])
    .where('incident_responders.incident_id', '=', incidentId)
    .orderBy('incident_responders.added_at')
    .orderBy('incident_responders.user_id')
    .execute();
  return rows.flatMap((row) => {
    const person = personOf(row);
    return person === null ? [] : [person];
  });
};

/** An incident as the contract says it, with its responders; undefined when there is none. */
const loadIncident = async (
  executor: Executor,
  by: { readonly id: string } | { readonly channelId: string },
): Promise<Incident | undefined> => {
  const row = await findIncident(executor, by);
  return row === undefined ? undefined : asIncident(row, await respondersOf(executor, row.id));
};

/** The channel's open incident, or once none is open its latest; null when it never had one. */
export const channelIncident = async (
  executor: Executor,
  context: ChannelContext,
): Promise<Incident | null> => {
  if (context.channelType === 'direct_message') return null;
  return (await loadIncident(executor, { channelId: context.channelId })) ?? null;
};

/** One entry of the timeline as it is stored: what kind, from what (a status's or a severity's), to what. */
export interface TimelineEntry {
  readonly kind: 'declared' | 'status' | 'severity' | 'responder_added' | 'responder_removed';
  readonly from: string | null;
  readonly to: string;
}

const entryOf = (
  change: IncidentChange & { kind: 'declared' | 'status' | 'severity' },
): TimelineEntry =>
  change.kind === 'declared'
    ? { kind: change.kind, from: null, to: String(change.severity) }
    : { kind: change.kind, from: String(change.from), to: String(change.to) };

/** Appends one entry to the timeline, after the newest whatever the clock says. */
export const record = async (
  executor: Transaction,
  incidentId: string,
  actorId: string,
  now: Date,
  entry: TimelineEntry,
): Promise<void> => {
  const newest = await executor
    .selectFrom('incident_updates')
    .select('id')
    .where('incident_id', '=', incidentId)
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  const instant =
    newest === undefined ? now.getTime() : Math.max(now.getTime(), messageIdTime(newest.id) + 1);
  await executor
    .insertInto('incident_updates')
    .values({
      id: messageId(new Date(instant)),
      incident_id: incidentId,
      kind: entry.kind,
      from_value: entry.from,
      to_value: entry.to,
      actor_id: actorId,
      at: now,
    })
    .execute();
};

/** The channel is one an incident may be declared in, and the caller is in it. */
export const requireWriter = async (
  executor: Transaction,
  context: ChannelContext,
): Promise<void> => {
  if (context.channelType === 'direct_message') throw channelNotFound();
  await requireChannelMember(executor, context, 'Join the channel to change its incident.');
};

/**
 * The same declaration again — this id, in this channel, at the severity it was declared at, whatever
 * it is now — is the incident it made; the id used any other way is a conflict that names nothing.
 * Null when the id is not in use.
 */
const sameDeclaration = async (
  executor: Executor,
  context: ChannelContext,
  input: DeclareIncidentRequest,
): Promise<IncidentWrite | null> => {
  const incident = await loadIncident(executor, { id: input.id });
  if (incident === undefined) return null;
  const declared = await executor
    .selectFrom('incident_updates')
    .select('to_value')
    .where('incident_id', '=', input.id)
    .where('kind', '=', 'declared')
    .executeTakeFirst();
  if (incident.channelId !== context.channelId || declared?.to_value !== String(input.severity)) {
    throw new AppError({
      code: 'INCIDENT_ID_CONFLICT',
      message: 'That incident id is already in use.',
    });
  }
  return { incident, changed: false };
};

/**
 * Declares an incident in the channel at this severity, investigating. A retry of a declaration —
 * after a lost answer, after the incident moved, after it was resolved and another declared — is
 * answered with the incident it made, and tells nobody.
 */
export const declareIncident = async (
  executor: Transaction,
  clock: Clock,
  context: ChannelContext,
  input: DeclareIncidentRequest,
): Promise<IncidentWrite> => {
  if (!isMessageIdShape(input.id)) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'An incident id is a UUIDv7.',
      details: { fields: { id: 'must be a UUIDv7' } },
    });
  }
  await requireWriter(executor, context);
  const earlier = await sameDeclaration(executor, context, input);
  if (earlier !== null) return earlier;
  const now = clock.now();
  const inserted = await executor
    .insertInto('incidents')
    .values({
      id: input.id,
      channel_id: context.channelId,
      workspace_id: context.workspaceId,
      severity: input.severity,
      declared_by: context.userId,
      declared_at: now,
    })
    // Whichever unique rule another declaration took first — the open index, or this very id from a
    // retry racing its first attempt — the indexes, not the read above, are the authority (D-78).
    .onConflict((conflict) => conflict.doNothing())
    .returning('id')
    .executeTakeFirst();
  if (inserted === undefined) {
    // Read again now the other has committed: the same declaration is answered, another use of the
    // id is a conflict, and anything else is another incident open here.
    const raced = await sameDeclaration(executor, context, input);
    if (raced !== null) return raced;
    throw new AppError({
      code: 'INCIDENT_OPEN',
      message: 'This channel already has an incident open.',
    });
  }
  await record(
    executor,
    input.id,
    context.userId,
    now,
    entryOf({ kind: 'declared', severity: input.severity }),
  );
  const made = await loadIncident(executor, { id: input.id });
  if (made === undefined) throw new Error(`incident ${input.id} is gone as it was declared`);
  return { incident: made, changed: true };
};

/** The incident as it is, for a change that was none. */
export const unchanged = async (executor: Executor, incidentId: string): Promise<IncidentWrite> => {
  const incident = await loadIncident(executor, { id: incidentId });
  if (incident === undefined) throw incidentNotFound();
  return { incident, changed: false };
};

/**
 * Moves the incident, or changes how bad it is, or both; resolving is a status like the others, once.
 * The row is locked for the change, so two at once are one after the other and both are on the
 * timeline in the order they were made.
 */
export const changeIncident = async (
  executor: Transaction,
  clock: Clock,
  context: ChannelContext,
  incidentId: string,
  input: ChangeIncidentRequest,
): Promise<IncidentWrite> => {
  await requireWriter(executor, context);
  if (!Value.Check(Uuid, incidentId)) throw incidentNotFound();
  const row = await executor
    .selectFrom('incidents')
    .select(['severity', 'status'])
    .where('id', '=', incidentId)
    .where('channel_id', '=', context.channelId)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (row === undefined) throw incidentNotFound();
  const was = { severity: severityOf(row.severity), status: statusOf(row.status) };
  const status = input.status ?? was.status;
  const severity = input.severity ?? was.severity;
  if (was.status === 'resolved') {
    // Asking for what it already is is answered; anything else is a change nothing may make.
    if (status !== was.status || severity !== was.severity) {
      throw new AppError({
        code: 'INCIDENT_RESOLVED',
        message: 'This incident is resolved. Declare a new one.',
      });
    }
    return await unchanged(executor, incidentId);
  }
  const changes: (IncidentChange & { kind: 'status' | 'severity' })[] = [
    ...(status === was.status ? [] : [{ kind: 'status', from: was.status, to: status } as const]),
    ...(severity === was.severity
      ? []
      : [{ kind: 'severity', from: was.severity, to: severity } as const]),
  ];
  if (changes.length > 0) {
    const now = clock.now();
    await executor
      .updateTable('incidents')
      .set({ status, severity, resolved_at: status === 'resolved' ? now : null })
      .where('id', '=', incidentId)
      .execute();
    for (const change of changes) {
      await record(executor, incidentId, context.userId, now, entryOf(change));
    }
  }
  const incident = await loadIncident(executor, { id: incidentId });
  if (incident === undefined) throw incidentNotFound();
  return { incident, changed: changes.length > 0 };
};

/** Reads one timeline value back into the change it was written from. */
const changeOf = (
  kind: string,
  from: string | null,
  to: string,
  people: ReadonlyMap<string, User>,
): IncidentChange => {
  switch (kind) {
    case 'responder_added':
    case 'responder_removed':
      return { kind, user: people.get(to) ?? null };
    case 'declared':
      return { kind, severity: severityOf(to) };
    case 'status':
      return { kind, from: openStatusOf(from ?? ''), to: statusOf(to) };
    case 'severity':
      return { kind, from: severityOf(from ?? ''), to: severityOf(to) };
    default:
      throw new Error(`an incident update is of kind ${kind}`);
  }
};

/** The incident's timeline, newest first, a page at a time. */
export const incidentUpdates = async (
  executor: Executor,
  context: ChannelContext,
  incidentId: string,
  query: OlderPageQuery,
): Promise<IncidentUpdatePage> => {
  if (!Value.Check(Uuid, incidentId)) throw incidentNotFound();
  const owned = await executor
    .selectFrom('incidents')
    .select('id')
    .where('id', '=', incidentId)
    .where('channel_id', '=', context.channelId)
    .executeTakeFirst();
  if (owned === undefined) throw incidentNotFound();
  const limit = limitOf(query);
  let statement = executor
    .selectFrom('incident_updates')
    .leftJoin('users', 'users.id', 'incident_updates.actor_id')
    .select([
      'incident_updates.id as id',
      'incident_updates.kind as kind',
      'incident_updates.from_value as from_value',
      'incident_updates.to_value as to_value',
      'incident_updates.at as at',
      'users.id as actor_id',
      'users.username as actor_username',
      'users.display_name as actor_display_name',
      'users.avatar_url as actor_avatar_url',
      'users.deleted_at as actor_deleted_at',
    ])
    .where('incident_updates.incident_id', '=', incidentId)
    .orderBy('incident_updates.id', 'desc')
    .limit(limit + 1);
  if (query.before !== undefined)
    statement = statement.where('incident_updates.id', '<', query.before);
  const rows = await statement.execute();
  const page = rows.slice(0, limit);
  // Who each responder entry names, in one read for the page: never a query an entry.
  const named = page
    .filter((row) => row.kind === 'responder_added' || row.kind === 'responder_removed')
    .map((row) => row.to_value);
  const people = new Map<string, User>();
  if (named.length > 0) {
    const found = await executor
      .selectFrom('users')
      .select([
        'id',
        'username',
        'display_name as displayName',
        'avatar_url as avatarUrl',
        'deleted_at as deletedAt',
      ])
      .where('id', 'in', [...new Set(named)])
      .execute();
    for (const row of found) {
      const person = personOf(row);
      if (person !== null) people.set(row.id, person);
    }
  }
  return {
    data: page.map((row) => ({
      id: row.id,
      at: at(row.at),
      actor: personOf({
        id: row.actor_id,
        username: row.actor_username,
        displayName: row.actor_display_name,
        avatarUrl: row.actor_avatar_url,
        deletedAt: row.actor_deleted_at,
      }),
      change: changeOf(row.kind, row.from_value, row.to_value, people),
    })),
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
};
