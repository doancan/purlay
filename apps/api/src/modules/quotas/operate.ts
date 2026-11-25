/**
 * The operator's side of the limits (#1306): `bun run quota:set <slug> <kind> <limit> --reason "…"`, `quota:clear <slug> <kind>` and
 * `quota:show <slug>`. A change locks the workspace's row, as issues' make does, so a make in flight is judged by one limit or the
 * other, never half of each; the deliveries' limit is soft by design (two publishes in flight may both pass, `outbox.ts`). It is the
 * same on a second run (nothing is written, nothing is recorded); and it is on the
 * workspace's trail as `quota.changed`, which kind, from and to, with no actor (the operator is nobody in the workspace) and never
 * the words of the reason, which stay in the row.
 */
import type { Executor } from '@purlay/db';
import type { Clock } from '../../platform/clock';
import {
  QUOTA_KINDS,
  QUOTA_LIMIT_MAX,
  isQuotaKind,
  limitFor,
  type QuotaKind,
} from '../../platform/quotas';
import { recordAudit } from '../audit/audit';

export interface QuotaLine {
  readonly kind: QuotaKind;
  readonly counts: string;
  /** The override, or `null` when the workspace takes the default. */
  readonly override: number | null;
  /** What is in force: the override, else the build's default, else `null` (not limited). */
  readonly inForce: number | null;
  /** The sentence the operator gave, when there is an override. */
  readonly reason: string | null;
}

/** The workspace's id by its slug, or `null` when no live workspace has it. */
const workspaceBySlug = async (executor: Executor, slug: string): Promise<string | null> =>
  (
    await executor
      .selectFrom('workspaces')
      .select('id')
      .where('slug', '=', slug)
      .where('deleted_at', 'is', null)
      .executeTakeFirst()
  )?.id ?? null;

/** A limit as an operator types it: whole numbers only, 0 to `QUOTA_LIMIT_MAX`; `null` for anything else. */
export const parseLimit = (text: string): number | null => {
  if (!/^\d{1,16}$/.test(text)) return null;
  const limit = Number(text);
  return limit <= QUOTA_LIMIT_MAX ? limit : null;
};

/** The longest reason the table holds. */
export const QUOTA_REASON_MAX = 500;

export type Operated =
  | { readonly kind: 'no-workspace' }
  | { readonly kind: 'no-reason' }
  | { readonly kind: 'reason-too-long' }
  | { readonly kind: 'done'; readonly changed: boolean; readonly workspaceId: string };

/** What the build's defaults are, by kind: what a workspace with no override gets (`null`: not limited). */
export type Defaults = Readonly<Record<QuotaKind, number | null>>;

/** Every kind with what is in force for the workspace and why; `null` when no live workspace has the slug. */
export const showQuotas = async (
  executor: Executor,
  slug: string,
  defaults: Defaults,
): Promise<readonly QuotaLine[] | null> => {
  const workspaceId = await workspaceBySlug(executor, slug);
  if (workspaceId === null) return null;
  const rows = await executor
    .selectFrom('workspace_quotas')
    .select(['kind', 'limit_value', 'reason'])
    .where('workspace_id', '=', workspaceId)
    .execute();
  return (Object.keys(QUOTA_KINDS) as QuotaKind[]).map((kind) => {
    const row = rows.find((found) => found.kind === kind);
    const override = row === undefined ? null : Number(row.limit_value);
    return {
      kind,
      counts: QUOTA_KINDS[kind],
      override,
      inForce: override ?? defaults[kind],
      reason: row?.reason ?? null,
    };
  });
};

/** Sets a limit (`limit` a number) or clears it (`null`); the kind is known to the caller. */
export const operateQuota = async (
  executor: Executor,
  clock: Clock,
  input: {
    readonly slug: string;
    readonly kind: QuotaKind;
    readonly limit: number | null;
    readonly reason: string | undefined;
  },
): Promise<Operated> => {
  const { slug, kind, limit, reason } = input;
  if (!isQuotaKind(kind)) throw new Error(`${String(kind)} is not a kind of limit`);
  const workspaceId = await workspaceBySlug(executor, slug);
  if (workspaceId === null) return { kind: 'no-workspace' };
  if (limit !== null && (reason === undefined || reason.trim() === ''))
    return { kind: 'no-reason' };
  if (reason !== undefined && reason.trim().length > QUOTA_REASON_MAX)
    return { kind: 'reason-too-long' };
  // The workspace's row is taken first, as issues' make takes it, and judged again under the lock: a purge that committed since the
  // address was read leaves nothing to write for.
  const locked = await executor
    .selectFrom('workspaces')
    .select('id')
    .where('id', '=', workspaceId)
    .where('deleted_at', 'is', null)
    .forNoKeyUpdate()
    .executeTakeFirst();
  if (locked === undefined) return { kind: 'no-workspace' };
  const before = await limitFor(executor, workspaceId, kind, null);
  const held = before !== null;
  if (limit === null ? !held : before === limit) {
    // The same again writes nothing, but a new reason is still the operator's to give.
    if (limit !== null && reason !== undefined) {
      await executor
        .updateTable('workspace_quotas')
        .set({ reason: reason.trim(), changed_at: clock.now() })
        .where('workspace_id', '=', workspaceId)
        .where('kind', '=', kind)
        .execute();
    }
    return { kind: 'done', changed: false, workspaceId };
  }
  if (limit === null) {
    await executor
      .deleteFrom('workspace_quotas')
      .where('workspace_id', '=', workspaceId)
      .where('kind', '=', kind)
      .execute();
  } else {
    await executor
      .insertInto('workspace_quotas')
      .values({
        workspace_id: workspaceId,
        kind,
        limit_value: String(limit),
        reason: (reason ?? '').trim(),
        changed_at: clock.now(),
      })
      .onConflict((conflict) =>
        conflict.columns(['workspace_id', 'kind']).doUpdateSet({
          limit_value: String(limit),
          reason: (reason ?? '').trim(),
          changed_at: clock.now(),
        }),
      )
      .execute();
  }
  await recordAudit(executor, clock, {
    workspaceId,
    actorUserId: null,
    action: 'quota.changed',
    targetType: 'workspace',
    targetId: workspaceId,
    // Absent when there is none, so the reader says "the default"; never the words of the reason.
    metadata: {
      kind,
      ...(before === null ? {} : { from: String(before) }),
      ...(limit === null ? {} : { to: String(limit) }),
    },
  });
  return { kind: 'done', changed: true, workspaceId };
};
