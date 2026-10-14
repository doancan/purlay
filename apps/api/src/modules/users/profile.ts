/**
 * A person's profile (#488, D-131): a title, the time zone their day is in, and a short status line.
 *
 * - **The person's own**: only they change it, through `/api/me`; the rest of a workspace reads it
 *   where they read the person — its members, which is where a conversation and a picker find them.
 * - **Words are trimmed**, and words that trim to nothing clear the field: a title of spaces is no
 *   title. The contract has already refused what no name may hold (`format: 'name'`).
 * - **A time zone is one the runtime knows**, stored as the runtime spells it, or it is refused, on
 *   `timeZone`.
 * - **A change says who to tell**: everyone in every workspace the person is in, so each reads the
 *   members again. Nothing changed, nobody is told.
 */
import type { Executor, Transaction } from '@purlay/db';
import type { Profile, UpdateProfileRequest } from '@purlay/types';
import { AppError } from '../../platform/errors';

/** The columns a profile is read from, beside a user's others. */
export const PROFILE_COLUMNS = ['users.title', 'users.time_zone', 'users.status_text'] as const;

interface ProfileRow {
  readonly title: string | null;
  readonly time_zone: string | null;
  readonly status_text: string | null;
}

export const asProfile = (row: ProfileRow): Profile => ({
  title: row.title,
  timeZone: row.time_zone,
  status: row.status_text,
});

/**
 * The zone's own name, as the runtime spells it — `europe/istanbul` is `Europe/Istanbul` — or null
 * for a zone it cannot format in. Stored spelled so, every reader gets the one name, and an offset
 * typed as a zone (`+05`) is not a zone.
 */
const canonicalZone = (zone: string): string | null => {
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
  return resolved.includes('/') || resolved === 'UTC' ? resolved : null;
};

/** A field's words as stored: trimmed, and nothing for words that trim to nothing. */
const stored = (value: string | null): string | null => {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/** What a profile change did: the profile as it is now, and who is to read the members again. */
export interface ProfileChange {
  readonly profile: Profile;
  /** Each workspace the person is in, with everyone in it; empty when nothing changed. */
  readonly told: readonly { readonly workspaceId: string; readonly memberIds: readonly string[] }[];
}

export const updateProfile = async (
  transaction: Transaction,
  userId: string,
  input: UpdateProfileRequest,
): Promise<ProfileChange> => {
  const zone = input.timeZone == null ? input.timeZone : canonicalZone(input.timeZone);
  if (zone === null && input.timeZone != null) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'That time zone is not one we know.',
      details: { fields: { timeZone: 'is not a known time zone' } },
    });
  }
  const before = await transaction
    .selectFrom('users')
    .select(['title', 'time_zone', 'status_text'])
    .where('id', '=', userId)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
  const after: ProfileRow = {
    title: input.title === undefined ? before.title : stored(input.title),
    time_zone: zone === undefined ? before.time_zone : zone,
    status_text: input.status === undefined ? before.status_text : stored(input.status),
  };
  if (
    after.title === before.title &&
    after.time_zone === before.time_zone &&
    after.status_text === before.status_text
  ) {
    return { profile: asProfile(before), told: [] };
  }
  await transaction.updateTable('users').set(after).where('id', '=', userId).execute();
  return { profile: asProfile(after), told: await workspacesOf(transaction, userId) };
};

/** Every workspace the person is in, with everyone in each: who sees their profile. */
const workspacesOf = async (executor: Executor, userId: string): Promise<ProfileChange['told']> => {
  const rows = await executor
    .selectFrom('workspace_members as mine')
    .innerJoin('workspaces', 'workspaces.id', 'mine.workspace_id')
    .innerJoin('workspace_members as everyone', 'everyone.workspace_id', 'mine.workspace_id')
    .select(['mine.workspace_id as workspaceId', 'everyone.user_id as memberId'])
    .where('mine.user_id', '=', userId)
    .where('workspaces.deleted_at', 'is', null)
    .orderBy('mine.workspace_id')
    .execute();
  const byWorkspace = new Map<string, string[]>();
  for (const row of rows) {
    const list = byWorkspace.get(row.workspaceId) ?? [];
    list.push(row.memberId);
    byWorkspace.set(row.workspaceId, list);
  }
  return [...byWorkspace].map(([workspaceId, memberIds]) => ({ workspaceId, memberIds }));
};
