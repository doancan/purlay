/**
 * A workspace's storage against its quota (D-16, D-173): one reading for the upload that is checked
 * against it and for the owner who is shown it, so the meter on Settings and a refused upload never
 * disagree.
 *
 * **Used** is what the workspace keeps — `storage_used_bytes`, which a message carrying a file adds
 * to — and every upload still waiting to be sent, which already holds its bytes in the store. Each
 * file is counted as it is kept: an image as its WebP (D-109 §2).
 *
 * **The quota is the operator's**: a column, set with `bun run storage:quota` (`CONFIG.md`), never by
 * an owner — it is the operator's disk.
 */
import { sql, type Executor } from '@purlay/db';
import type { StorageUsage } from '@purlay/types';
import { AppError } from '../../platform/errors';
import type { WorkspaceContext } from '../../platform/tenancy';

export interface Storage {
  readonly quotaBytes: bigint;
  readonly usedBytes: bigint;
}

/**
 * The workspace's quota and what counts against it, in two statements. With `lock`, the workspace row
 * is taken first, so uploads into one workspace take turns from here and a quota is checked once per
 * byte (`uploads.ts`).
 */
export const storageOf = async (
  executor: Executor,
  workspaceId: string,
  { lock }: { readonly lock: boolean },
): Promise<Storage> => {
  const row = executor
    .selectFrom('workspaces')
    .select(['storage_quota_bytes', 'storage_used_bytes'])
    .where('id', '=', workspaceId);
  const workspace = await (lock ? row.forUpdate() : row).executeTakeFirstOrThrow();
  const waiting = await executor
    .selectFrom('attachments')
    .select(sql<string>`coalesce(sum(size_bytes), 0)`.as('bytes'))
    .where('workspace_id', '=', workspaceId)
    .where('message_id', 'is', null)
    .executeTakeFirstOrThrow();
  // BIGINT arrives as text: summed as integers, never as strings.
  return {
    quotaBytes: BigInt(workspace.storage_quota_bytes),
    usedBytes: BigInt(workspace.storage_used_bytes) + BigInt(waiting.bytes),
  };
};

/** `GET …/storage` — an owner's, as the other things an operator pays for are (D-173). */
export const readStorage = async (
  executor: Executor,
  context: WorkspaceContext,
): Promise<StorageUsage> => {
  if (context.role !== 'owner') {
    throw new AppError({
      code: 'FORBIDDEN',
      message: 'Only an owner sees how much of the workspace’s storage is used.',
    });
  }
  const { quotaBytes, usedBytes } = await storageOf(executor, context.workspaceId, { lock: false });
  return { usedBytes: Number(usedBytes), quotaBytes: Number(quotaBytes) };
};

const UNITS: Readonly<Record<string, bigint>> = {
  '': 1n,
  B: 1n,
  KiB: 1024n,
  MiB: 1024n ** 2n,
  GiB: 1024n ** 3n,
  TiB: 1024n ** 4n,
};

/** The largest quota the column and the wire both hold exactly: a JSON number past 2^53 is not one. */
export const QUOTA_BYTES_MAX = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * A quota as an operator types it — whole bytes, or a whole number of `KiB`, `MiB`, `GiB` or `TiB`
 * (`5GiB`, `500 MiB`) — or null for anything else. Decimal units are refused rather than guessed:
 * `5GB` is a different number to different people, and a quota is a promise about a disk.
 */
export const parseQuota = (text: string): bigint | null => {
  const match = /^(\d{1,16})\s*(B|KiB|MiB|GiB|TiB)?$/.exec(text.trim());
  if (match === null) return null;
  const bytes = BigInt(match[1] ?? '') * (UNITS[match[2] ?? ''] ?? 1n);
  return bytes <= QUOTA_BYTES_MAX ? bytes : null;
};

/** A count of bytes in the largest binary unit it fills, to a tenth, for an operator's terminal. */
export const saidBytes = (bytes: bigint): string => {
  for (const unit of ['TiB', 'GiB', 'MiB', 'KiB'] as const) {
    const size = UNITS[unit] ?? 1n;
    if (bytes >= size) {
      return `${String(Math.round((Number(bytes) / Number(size)) * 10) / 10)} ${unit}`;
    }
  }
  return `${String(bytes)} B`;
};

export interface QuotaReport {
  readonly workspaceId: string;
  readonly quotaBytes: bigint;
  readonly usedBytes: bigint;
}

/**
 * `bun run storage:quota <slug> [<size>]` — the workspace's storage, and with a size its new quota.
 * The row is locked as an upload locks it, so an upload in flight is checked against one quota or the
 * other, never half of each. A quota below what is used is allowed: nothing is deleted, and uploads
 * are refused until there is room. Null when no live workspace has the slug.
 */
export const operateQuota = async (
  executor: Executor,
  slug: string,
  quotaBytes: bigint | null,
): Promise<QuotaReport | null> => {
  const workspace = await executor
    .selectFrom('workspaces')
    .select('id')
    .where('slug', '=', slug)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (workspace === undefined) return null;
  const now = await storageOf(executor, workspace.id, { lock: quotaBytes !== null });
  if (quotaBytes === null) return { workspaceId: workspace.id, ...now };
  await executor
    .updateTable('workspaces')
    .set({ storage_quota_bytes: String(quotaBytes) })
    .where('id', '=', workspace.id)
    .execute();
  return { workspaceId: workspace.id, quotaBytes, usedBytes: now.usedBytes };
};
