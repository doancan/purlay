/**
 * What one workspace may do, as one number each (#1306): the gate every limit that an operator may move is read through. A limit is
 * the workspace's override (`workspace_quotas`, written by `bun run quota:set`), else the default the caller says, else none. The
 * callers do the arithmetic and refuse in their own words, so a refusal reads as the feature's own; the gate says only the number.
 *
 * Storage is not here: its quota is a column of the workspace and has its own command (`bun run storage:quota`, D-173).
 */
import type { Executor } from '@purlay/db';

/**
 * The limits an operator may set, and what each counts. A kind is a key: `<name>` of the core, `<module>:<name>` of a module (a core
 * table names no module, D-250 rule 5), so a build that does not carry the module has no use for its kind.
 */
export const QUOTA_KINDS = {
  /** Facts a workspace queues for delivery in one minute, counted as the outbox's rows (`outbox.ts`). */
  deliveries_per_minute: 'queued deliveries per minute',
  /** Issues a workspace may hold (`features/issues/issues.ts`). */
  'issues:rows': 'issues held',
} as const;

export type QuotaKind = keyof typeof QUOTA_KINDS;

/** Own keys only: `constructor` and `toString` are in every object and are no kind of limit. */
export const isQuotaKind = (text: string): text is QuotaKind => Object.hasOwn(QUOTA_KINDS, text);

/** The largest limit a column and a JSON number both hold exactly. */
export const QUOTA_LIMIT_MAX = Number.MAX_SAFE_INTEGER;

/**
 * The limit in force for a workspace: its override, else `fallback`, else `null` (not limited). One read by the primary key of the
 * table; a limit of 0 is a limit.
 */
export const limitFor = async (
  executor: Executor,
  workspaceId: string,
  kind: QuotaKind,
  fallback: number | null,
): Promise<number | null> => {
  const row = await executor
    .selectFrom('workspace_quotas')
    .select('limit_value')
    .where('workspace_id', '=', workspaceId)
    .where('kind', '=', kind)
    .executeTakeFirst();
  return row === undefined ? fallback : Number(row.limit_value);
};

/** Whether adding `adding` to `held` passes `limit`; no limit never does. */
export const passes = (limit: number | null, held: number, adding: number): boolean =>
  limit !== null && held + adding > limit;
