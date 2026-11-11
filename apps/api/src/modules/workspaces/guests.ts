/** Guest membership administration keeps authority in core and conversation scope in its owning port. */
import { Value } from '@sinclair/typebox/value';
import { sql, type Executor } from '@purlay/db';
import { PAGE_LIMIT, WorkspaceGuestQuery, type WorkspaceGuestPage } from '@purlay/types';
import { AppError, routeNotFound } from '../../platform/errors';
import { literalPattern } from '../../platform/like-pattern';
import {
  assertMinted,
  entitledTo,
  requireWorkspaceMembership,
  type WorkspaceContext,
} from '../../platform/tenancy';
import { requireInvitationManager } from './invitation-manager';
import { noWorkspaceChannels, type WorkspaceChannels } from './channels-port';

const guestNotFound = (): AppError =>
  new AppError({ code: 'USER_NOT_FOUND', message: 'That guest is not in this workspace.' });

export const listWorkspaceGuests = async (
  executor: Executor,
  context: WorkspaceContext,
  query: WorkspaceGuestQuery,
  channels: WorkspaceChannels = noWorkspaceChannels,
): Promise<WorkspaceGuestPage> => {
  assertMinted(context);
  const current = await requireWorkspaceMembership(executor, context.userId, context.workspaceId);
  requireInvitationManager(current);
  if (!Value.Check(WorkspaceGuestQuery, query))
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'The guest list filters did not match the contract.',
      details: { fields: { query: 'Check the guest list filters.' } },
    });
  if (channels.guests === undefined || !entitledTo(current, channels.guests.moduleId))
    throw routeNotFound();
  const limit = query.limit ?? PAGE_LIMIT.default;
  let statement = executor
    .selectFrom('workspace_members')
    .innerJoin('users', 'users.id', 'workspace_members.user_id')
    .select([
      'users.id',
      'users.username',
      'users.display_name',
      'users.avatar_url',
      'workspace_members.joined_at',
      'workspace_members.guest_since',
      'workspace_members.guest_expires_at',
    ])
    .where('workspace_members.workspace_id', '=', current.workspaceId)
    .where('workspace_members.access_kind', '=', sql.lit('guest'))
    .where('users.deleted_at', 'is', null)
    .orderBy('workspace_members.joined_at', 'desc')
    .orderBy('workspace_members.user_id', 'desc')
    .limit(limit + 1);
  if (query.before !== undefined) {
    const cursor = await executor
      .selectFrom('workspace_members')
      .innerJoin('users', 'users.id', 'workspace_members.user_id')
      .select('workspace_members.joined_at')
      .where('workspace_members.workspace_id', '=', current.workspaceId)
      .where('workspace_members.access_kind', '=', 'guest')
      .where('workspace_members.user_id', '=', query.before)
      .where('users.deleted_at', 'is', null)
      .executeTakeFirst();
    if (cursor === undefined) throw guestNotFound();
    statement = statement.where((eb) =>
      eb.or([
        eb('workspace_members.joined_at', '<', cursor.joined_at),
        eb.and([
          eb('workspace_members.joined_at', '=', cursor.joined_at),
          eb('workspace_members.user_id', '<', query.before ?? ''),
        ]),
      ]),
    );
  }
  if (query.q !== undefined && query.q.trim() !== '') {
    const pattern = literalPattern(query.q.trim());
    statement = statement.where((eb) =>
      eb.or([eb('users.display_name', 'ilike', pattern), eb('users.username', 'ilike', pattern)]),
    );
  }
  const rows = await statement.execute();
  const page = rows.slice(0, limit);
  const scopes = await channels.guests.scopes(
    executor,
    current,
    page.map((row) => row.id),
  );
  return {
    data: page.map((row) => {
      if (row.guest_since === null) throw new Error('A guest membership has no history floor');
      const scope = scopes.get(row.id);
      return {
        user: {
          id: row.id,
          username: row.username,
          displayName: row.display_name,
          avatarUrl: row.avatar_url,
        },
        joinedAt: new Date(row.joined_at).toISOString(),
        access: {
          kind: 'guest' as const,
          historySince: new Date(row.guest_since).toISOString(),
          expiresAt:
            row.guest_expires_at === null ? null : new Date(row.guest_expires_at).toISOString(),
        },
        channelIds: [...(scope?.visibleIds ?? [])],
        hiddenChannelCount: scope?.hiddenCount ?? 0,
      };
    }),
    nextCursor: rows.length > limit ? (page.at(-1)?.id ?? null) : null,
  };
};
