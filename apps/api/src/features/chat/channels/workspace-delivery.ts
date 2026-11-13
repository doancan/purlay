/** Final output follows the socket's exact native source, including queued and replayed frames. */
import type { Clock } from '../../../platform/clock';
import type { ServerFrame } from '@purlay/types';
import { AppError } from '../../../platform/errors';
import { withinRequest, type RequestScope } from '../../../platform/logging';
import { sql, type AliasableExpression } from '@purlay/db';
import { visibleChannels } from './guard';
import { guestMessageHistoryFor } from './history-access';
import type {
  ChannelDeliveryScope,
  WorkspaceFrameProjector,
} from '../../../platform/ports/channel-delivery';
import {
  activeWorkspaceMembership,
  buildCompanyProofBatch,
  type readonlyWorkspaceAccess,
  readWorkspaceContentPermits,
  type WorkspaceContentPermit,
} from '../../../platform/tenancy';
import type { ChatDb } from '../schema';

type Lifetime = Parameters<typeof readonlyWorkspaceAccess>[2];
/** Small final statements keep the measured planner cost below the realtime delivery budget. */
const FINAL_BATCH_MAX = 8;

interface WaitingSource {
  readonly sessionId: string;
  readonly userId: string;
  readonly signal: AbortSignal;
  readonly resolve: (permit: WorkspaceContentPermit | 'off' | undefined) => void;
  readonly reject: (error: unknown) => void;
}

export const workspaceFrameProjector = (
  database: ChatDb,
  clock: Clock,
  lifetime: Lifetime,
): WorkspaceFrameProjector => {
  const pending = new WeakMap<ServerFrame, Map<string, WaitingSource[]>>();
  const counters = new Map<string, WaitingSource[]>();
  const channelRoutes = new WeakMap<
    ServerFrame,
    Promise<
      | {
          readonly workspace_id: string;
          readonly access_policy_epoch: string;
        }
      | undefined
    >
  >();
  interface Route {
    readonly workspace_id: string;
    readonly access_policy_epoch: string;
  }
  const counterRoutes = new Map<string, Promise<Route | undefined>>();
  const readRoute = async (channelId: string): Promise<Route | undefined> =>
    await database
      .selectFrom('channels')
      .innerJoin('workspaces', 'workspaces.id', 'channels.workspace_id')
      .select(['channels.workspace_id', 'workspaces.access_policy_epoch'])
      .where('channels.id', '=', channelId)
      .executeTakeFirst();
  const sourceFor = (
    frame: ServerFrame,
    workspaceId: string,
    sessionId: string,
    userId: string,
    signal: AbortSignal,
  ): Promise<WorkspaceContentPermit | 'off' | undefined> => {
    const groups =
      frame.event === 'CHANNEL_STATE'
        ? counters
        : (pending.get(frame) ?? new Map<string, WaitingSource[]>());
    if (frame.event !== 'CHANNEL_STATE') pending.set(frame, groups);
    let waiting = groups.get(workspaceId);
    if (waiting === undefined) {
      waiting = [];
      const batch = waiting;
      groups.set(workspaceId, batch);
      queueMicrotask(() => {
        // Detach before dispatch: a late recipient never inherits a completed or already-running read.
        if (groups.get(workspaceId) === batch) groups.delete(workspaceId);
        void (async (): Promise<void> => {
          try {
            const active = batch.filter((row) => !row.signal.aborted);
            const routed = await channelRoutes.get(frame);
            // Routing supplies only an epoch hint; the final statement still checks current visibility and policy.
            const workspace =
              active.length === 0
                ? undefined
                : routed?.workspace_id === workspaceId
                  ? routed
                  : await database
                      .selectFrom('workspaces')
                      .select('access_policy_epoch')
                      .where('id', '=', workspaceId)
                      .where('deleted_at', 'is', null)
                      .executeTakeFirst();
            const permits =
              workspace === undefined || workspace.access_policy_epoch === '0'
                ? undefined
                : await readWorkspaceContentPermits(database, {
                    workspaceId,
                    sessionIds: active.map((row) => row.sessionId),
                    now: clock.now(),
                    lifetime: lifetime(),
                  });
            for (const row of batch) {
              if (row.signal.aborted) row.reject(row.signal.reason);
              else {
                const permit = permits?.get(row.sessionId);
                row.resolve(
                  workspace?.access_policy_epoch === '0'
                    ? 'off'
                    : permit?.userId === row.userId
                      ? permit
                      : undefined,
                );
              }
            }
          } catch (error) {
            for (const row of batch) row.reject(error);
          }
        })();
      });
    }
    const batch = waiting;
    return new Promise((resolve, reject) => {
      batch.push({ sessionId, userId, signal, resolve, reject });
      if (batch.length >= 100 && groups.get(workspaceId) === batch) groups.delete(workspaceId);
    });
  };
  type Result = Awaited<ReturnType<WorkspaceFrameProjector>>;
  type Identity = Parameters<WorkspaceFrameProjector>[0];
  interface ReadyRow {
    sourceKey: string;
    accessKind: string;
    guestSince: Date | null;
    guestExpiresAt: Date | null;
    channelJoinedAt: Date | null;
    historyAllowed: boolean;
  }
  interface VisibilityRow extends ReadyRow {
    id: string;
    workspace_id: string;
    user_id: string;
    access_policy_epoch: string;
    access_kind: string;
    guest_since: Date | null;
    guest_expires_at: Date | null;
  }
  interface Ready {
    readonly key: string;
    readonly identity: Identity;
    readonly workspaceId: string;
    readonly channelId: string | undefined;
    readonly frame: ServerFrame;
    readonly signal: AbortSignal;
    readonly scope: ChannelDeliveryScope | undefined;
    readonly query: () => AliasableExpression<ReadyRow>;
    readonly permit: WorkspaceContentPermit | 'off';
    readonly resolve: (result: Result) => void;
    readonly reject: (error: unknown) => void;
  }
  const readyGroups = new WeakMap<object, Ready[]>();
  const personalReadyGroups = new WeakMap<object, Ready[]>();
  const counterKey = {};
  const scopeKey = (row: ReadyRow, entry: Ready): string =>
    JSON.stringify([
      entry.workspaceId,
      entry.channelId,
      entry.identity.userId,
      row.accessKind === 'guest'
        ? {
            kind: 'guest',
            historySince: new Date(
              Math.max(
                new Date(row.guestSince ?? 0).getTime(),
                new Date(row.channelJoinedAt ?? 0).getTime(),
              ),
            ).toISOString(),
            expiresAt:
              row.guestExpiresAt === null ? null : new Date(row.guestExpiresAt).toISOString(),
          }
        : null,
    ]);
  const sourceScope = (
    identity: Identity,
    signal: AbortSignal,
    captured = false,
  ): RequestScope => ({
    requestId: `live:workspace:${identity.sessionId}`,
    startedAt: performance.now(),
    sessionId: identity.sessionId,
    module: 'chat',
    signal,
    ...(identity.companyWorkspaceId === undefined || captured
      ? {}
      : { companySession: { userId: identity.userId, workspaceId: identity.companyWorkspaceId } }),
  });
  const finalQuery = (
    entry: Omit<Ready, 'query' | 'resolve' | 'reject' | 'permit'>,
    permit: WorkspaceContentPermit | 'off',
    channelBatch = false,
  ): AliasableExpression<ReadyRow> =>
    withinRequest(sourceScope(entry.identity, entry.signal, permit !== 'off'), () => {
      if (permit !== 'off') permit.capture(clock.now());
      const { identity, workspaceId, key } = entry;
      if (channelBatch)
        return database
          .selectFrom(sql<VisibilityRow>`ready_channel_visibility`.as('workspaces'))
          .innerJoin(sql<VisibilityRow>`ready_channel_visibility`.as('workspace_members'), (join) =>
            join.onRef('workspace_members.sourceKey', '=', 'workspaces.sourceKey'),
          )
          .select([
            'workspaces.sourceKey',
            'workspaces.accessKind',
            'workspaces.guestSince',
            'workspaces.guestExpiresAt',
            'workspaces.channelJoinedAt',
            'workspaces.historyAllowed',
          ])
          .where('workspaces.sourceKey', '=', key)
          .where(activeWorkspaceMembership());
      return database
        .selectFrom('workspaces')
        .innerJoin('workspace_members', 'workspace_members.workspace_id', 'workspaces.id')
        .select((eb) => [
          eb.val(key).as('sourceKey'),
          'workspace_members.access_kind as accessKind',
          'workspace_members.guest_since as guestSince',
          'workspace_members.guest_expires_at as guestExpiresAt',
          eb.val<Date | null>(null).as('channelJoinedAt'),
          eb.val(true).as('historyAllowed'),
        ])
        .where('workspaces.id', '=', workspaceId)
        .where('workspaces.deleted_at', 'is', null)
        .where('workspace_members.user_id', '=', identity.userId)
        .where(activeWorkspaceMembership())
        .where((eb) =>
          eb.or([
            eb('workspace_members.access_kind', '=', 'member'),
            eb(
              eb.fn<number | null>('array_position', [
                eb.ref('workspace_members.guest_modules'),
                eb.val('chat'),
              ]),
              'is not',
              null,
            ),
          ]),
        )
        .$castTo<ReadyRow>();
    });
  /** Shared visibility facts stay in the final statement's snapshot; exact native fences are applied below. */
  const channelVisibilityQuery = (
    entries: readonly Ready[],
  ): AliasableExpression<VisibilityRow> => {
    const first = entries[0];
    if (first === undefined) throw new Error('Missing channel recipients');
    const recipients = sql<{
      source_key: string;
      user_id: string;
      workspace_id: string;
      channel_id: string;
    }>`(values ${sql.join(
      entries.map(
        (entry) => sql`(${entry.key}::text, ${entry.identity.userId}::uuid,
        ${entry.workspaceId}::uuid, ${entry.channelId}::uuid)`,
      ),
    )})`.as<'ready_recipients'>(
      sql`ready_recipients(source_key, user_id, workspace_id, channel_id)`,
    );
    return withinRequest(sourceScope(first.identity, first.signal, true), () => {
      const message =
        first.frame.event === 'MESSAGE_CREATED'
          ? first.frame.data.id
          : 'messageId' in first.frame.data
            ? first.frame.data.messageId
            : undefined;
      const access = visibleChannels(database, sql.ref<string>('ready_recipients.user_id'), {
        visibilityOnly: true,
      })
        .where('channels.id', '=', sql.ref<string>('ready_recipients.channel_id'))
        .where('channels.workspace_id', '=', sql.ref<string>('ready_recipients.workspace_id'))
        .select((eb) => [
          'workspaces.id',
          'workspaces.access_policy_epoch',
          'workspace_members.workspace_id',
          'workspace_members.user_id',
          'workspace_members.access_kind',
          'workspace_members.guest_since',
          'workspace_members.guest_expires_at',
          sql.ref<string>('ready_recipients.source_key').as('sourceKey'),
          'workspace_members.access_kind as accessKind',
          'workspace_members.guest_since as guestSince',
          'workspace_members.guest_expires_at as guestExpiresAt',
          'channel_members.joined_at as channelJoinedAt',
          (message === undefined
            ? eb.val(true)
            : eb.or([
                eb('workspace_members.access_kind', '=', 'member'),
                eb.exists(
                  eb
                    .selectFrom('messages as ready_message')
                    .select('ready_message.id')
                    .where('ready_message.id', '=', message)
                    .whereRef('ready_message.channel_id', '=', 'channels.id')
                    .whereRef('ready_message.workspace_id', '=', 'channels.workspace_id')
                    .where(guestMessageHistoryFor('ready_message')),
                ),
              ])
          ).as('historyAllowed'),
        ])
        .$castTo<VisibilityRow>();
      return database
        .selectFrom(recipients)
        .innerJoinLateral(access.as('personal_access'), (join) => join.onTrue())
        .selectAll('personal_access');
    });
  };
  const ready = (
    identity: Identity,
    workspaceId: string,
    channelId: string | undefined,
    frame: ServerFrame,
    signal: AbortSignal,
    scope: ChannelDeliveryScope | undefined,
    permit: WorkspaceContentPermit | 'off',
  ): Promise<Result> => {
    const personal =
      permit === 'off' && identity.companyWorkspaceId === undefined && channelId !== undefined;
    const groups = personal ? personalReadyGroups : readyGroups;
    const batchKey = frame.event === 'CHANNEL_STATE' ? counterKey : frame;
    const limit = personal ? 100 : FINAL_BATCH_MAX;
    let group = groups.get(batchKey);
    if (group === undefined) {
      group = [];
      groups.set(batchKey, group);
    }
    const batch = group;
    if (batch.length === 0)
      queueMicrotask(() => {
        const selected = batch.splice(0, limit);
        if (groups.get(batchKey) === batch) groups.delete(batchKey);
        void (async (): Promise<void> => {
          const active: Ready[] = [];
          const channelBatch = selected.every((entry) => entry.channelId !== undefined);
          const visibilitySource = channelBatch ? channelVisibilityQuery(selected) : undefined;
          const proofBatch = buildCompanyProofBatch<ReadyRow>(
            selected
              .filter((entry) => !entry.signal.aborted)
              .map((entry) => entry.identity.sessionId),
            () => {
              const queries: AliasableExpression<ReadyRow>[] = [];
              for (const entry of selected) {
                if (entry.signal.aborted) {
                  entry.reject(entry.signal.reason);
                  continue;
                }
                try {
                  if (!personal)
                    queries.push(
                      channelBatch ? finalQuery(entry, entry.permit, true) : entry.query(),
                    );
                  active.push(entry);
                } catch (error) {
                  if (error instanceof AppError && error.body.code === 'WORKSPACE_ACCESS_REQUIRED')
                    entry.resolve({ workspaceId: entry.workspaceId, channelIds: [] });
                  else entry.reject(error);
                }
              }
              if (personal && active.length > 0)
                queries.push(
                  database
                    .selectFrom(
                      sql<VisibilityRow>`ready_channel_visibility`.as('personal_visibility'),
                    )
                    .select([
                      'personal_visibility.sourceKey',
                      'personal_visibility.accessKind',
                      'personal_visibility.guestSince',
                      'personal_visibility.guestExpiresAt',
                      'personal_visibility.channelJoinedAt',
                      'personal_visibility.historyAllowed',
                    ])
                    .where('personal_visibility.access_policy_epoch', '=', '0'),
                );
              return queries;
            },
          );
          const { queries } = proofBatch;
          const first = queries[0];
          if (first === undefined) return;
          try {
            let query = database
              .with(
                (cte) => cte(proofBatch.name).materialized(),
                () => proofBatch.source,
              )
              .with(
                (cte) => cte('ready_channel_visibility').materialized(),
                () => visibilitySource ?? sql<VisibilityRow>`(select null where false)`,
              )
              .selectFrom(first.as('ready_sources'))
              .selectAll('ready_sources');
            for (const next of queries.slice(1)) query = query.unionAll(next);
            const rows = await query.execute();
            const known = new Map(rows.map((row) => [row.sourceKey, row]));
            // No asynchronous work remains after this final statement: the hub writes each ready result synchronously.
            for (const entry of active) {
              if (entry.signal.aborted) {
                entry.reject(entry.signal.reason);
                continue;
              }
              const row = known.get(entry.key);
              if (row === undefined)
                entry.resolve({ workspaceId: entry.workspaceId, channelIds: [] });
              else if (
                entry.channelId !== undefined &&
                entry.scope !== undefined &&
                scopeKey(row, entry) !== entry.scope.key
              )
                entry.resolve({ workspaceId: entry.workspaceId, channelIds: [], changed: true });
              else entry.resolve({ frame: row.historyAllowed ? entry.frame : undefined });
            }
          } catch (error) {
            for (const entry of active) entry.reject(error);
          }
        })();
      });
    return new Promise((resolve, reject) => {
      const entry = {
        key: crypto.randomUUID(),
        identity,
        workspaceId,
        channelId,
        frame,
        signal,
        scope,
      };
      batch.push({ ...entry, permit, query: () => finalQuery(entry, permit), resolve, reject });
      if (batch.length === limit && groups.get(batchKey) === batch) groups.delete(batchKey);
    });
  };
  return async (identity, _channelIds, frame, signal, channelScope): Promise<Result> => {
    let workspaceId: string | undefined;
    let channelId: string | undefined;
    switch (frame.event) {
      case 'SESSION_ENDED':
      case 'ACK':
      case 'ERROR':
      case 'PONG':
        return { frame };
      case 'ACCESS_REVOKED': {
        if (identity.companyWorkspaceId === undefined) return { frame };
        const rows = await database
          .selectFrom('channels')
          .select('id')
          .where('workspace_id', '=', identity.companyWorkspaceId)
          .where('id', 'in', frame.data.channelIds)
          .execute();
        const allowed = new Set(rows.map((row) => row.id));
        const channelIds = frame.data.channelIds.filter((id) => allowed.has(id));
        return {
          frame:
            channelIds.length === 0 ? undefined : { ...frame, data: { ...frame.data, channelIds } },
        };
      }
      case 'WORKSPACE_UPDATED': {
        if (
          identity.companyWorkspaceId !== undefined &&
          identity.companyWorkspaceId !== frame.data.workspaceId
        )
          return { frame: undefined };
        // Membership loss is a control hint, not content authority. Legacy guest resync remains unchanged.
        if (frame.data.accessChanged !== true) return { frame };
        const workspace = await database
          .selectFrom('workspaces')
          .select('access_policy_epoch')
          .where('id', '=', frame.data.workspaceId)
          .executeTakeFirst();
        return workspace?.access_policy_epoch === '0' ? { restart: frame } : { frame };
      }
      case 'DEEP_WORK_UPDATED':
      case 'INBOX_UPDATED':
      case 'SAVED_UPDATED':
      case 'REMINDERS_UPDATED':
      case 'NOTIFICATIONS_UPDATED':
      case 'CHANNELS_UPDATED':
        workspaceId = frame.data.workspaceId;
        break;
      case 'CHANNEL_ADDED':
        workspaceId = frame.data.workspaceId;
        channelId = frame.data.id;
        break;
      case 'MESSAGE_CREATED':
      case 'MESSAGE_REVISED':
      case 'MESSAGE_HIDDEN':
      case 'THREAD_UPDATED':
      case 'REACTIONS_UPDATED':
      case 'CHANNEL_STATE':
      case 'CHANNEL_UPDATED':
      case 'PINS_UPDATED':
      case 'BOOKMARKS_UPDATED':
      case 'INCIDENT_UPDATED':
      case 'MESSAGE_VERSIONS_UPDATED':
      case 'TYPING': {
        channelId = frame.data.channelId;
        let found =
          frame.event === 'CHANNEL_STATE' ? counterRoutes.get(channelId) : channelRoutes.get(frame);
        if (found === undefined) {
          if (frame.event === 'CHANNEL_STATE') {
            const id = channelId;
            found = new Promise<Route | undefined>((resolve, reject) => {
              queueMicrotask(() => {
                // Detach before dispatch so later recipients cannot reuse a started or completed routing read.
                counterRoutes.delete(id);
                void readRoute(id).then(resolve, reject);
              });
            });
            counterRoutes.set(id, found);
          } else found = readRoute(channelId);
        }
        channelRoutes.set(frame, found);
        workspaceId = (await found)?.workspace_id;
        break;
      }
      case 'PRESENCE': {
        const rows = await database
          .selectFrom('workspace_members as peer')
          .innerJoin('workspace_members as own', 'own.workspace_id', 'peer.workspace_id')
          .select(['peer.user_id', 'peer.workspace_id'])
          .where('own.user_id', '=', identity.userId)
          .where(
            'peer.user_id',
            'in',
            frame.data.changes.map((change) => change.userId),
          )
          .execute();
        const ids = [...new Set(rows.map((row) => row.workspace_id))];
        const permits = await Promise.all(
          ids.map((id) => sourceFor(frame, id, identity.sessionId, identity.userId, signal)),
        );
        const results = await Promise.all(
          ids.map((id, index) => {
            const permit = permits[index];
            return permit === undefined || (permit !== 'off' && !permit.decision.allowed)
              ? Promise.resolve(undefined)
              : ready(identity, id, undefined, frame, signal, undefined, permit);
          }),
        );
        const allowed = new Set(
          ids.filter((_id, index) => {
            const result = results[index];
            return result !== undefined && 'frame' in result && result.frame !== undefined;
          }),
        );
        const people = new Set(
          rows.filter((row) => allowed.has(row.workspace_id)).map((row) => row.user_id),
        );
        const changes = frame.data.changes.filter((change) => people.has(change.userId));
        return { frame: changes.length === 0 ? undefined : { ...frame, data: { changes } } };
      }
    }
    if (workspaceId === undefined) return { frame: undefined };
    if (identity.companyWorkspaceId !== undefined && identity.companyWorkspaceId !== workspaceId)
      return { frame: undefined };
    const permit = await sourceFor(frame, workspaceId, identity.sessionId, identity.userId, signal);
    if (permit === undefined || (permit !== 'off' && !permit.decision.allowed))
      return { workspaceId, channelIds: [] };
    return await ready(identity, workspaceId, channelId, frame, signal, channelScope, permit);
  };
};
