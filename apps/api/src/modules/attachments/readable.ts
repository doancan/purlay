/**
 * Who may read an attachment's bytes, as far as the core knows (`/api/attachments/:attachmentId`, D-109 §6).
 *
 * The core's table holds a stored object, its uploader and its workspace, and the core's answer is the upload
 * nobody has attached: its uploader's, while they are in its workspace. A file attached to something belongs to
 * whatever it was attached to, and that module answers for it (`composition.ts`, `MODULES.md` §3).
 */
import { Value } from '@sinclair/typebox/value';
import { Uuid, type AttachmentKind } from '@purlay/types';
import type { Database, Executor, Expression, ExpressionBuilder, SqlBool } from '@purlay/db';
import { attachmentNotFound } from '../../platform/errors';
import { activeWorkspaceMembership } from '../../platform/membership-access';

/** An attachment the caller may read, with where its bytes are. */
export interface ReadableAttachment {
  readonly id: string;
  readonly storageKey: string;
  /** An image's thumbnail; null for a file. */
  readonly thumbnailKey: string | null;
  readonly fileName: string;
  readonly kind: AttachmentKind;
}

/** Finds an attachment for a reader, or refuses it with `attachmentNotFound`. */
export type AttachmentReader = (
  executor: Executor,
  userId: string,
  attachmentId: string,
) => Promise<ReadableAttachment>;

/** An upload nobody has attached, by a person who is still in its live workspace. */
export const isUnsentUploadOf = (
  eb: ExpressionBuilder<Database, 'attachments'>,
  userId: string,
): Expression<SqlBool> =>
  eb.and([
    eb('attachments.claimed_at', 'is', null),
    eb('attachments.uploader_id', '=', userId),
    eb.exists(
      eb
        .selectFrom('workspace_members')
        .innerJoin('workspaces', 'workspaces.id', 'workspace_members.workspace_id')
        .select('workspace_members.user_id')
        .whereRef('workspace_members.workspace_id', '=', 'attachments.workspace_id')
        .where('workspace_members.user_id', '=', userId)
        .where(activeWorkspaceMembership())
        .where('workspaces.deleted_at', 'is', null),
    ),
  ]);

/** The core's reader: only the caller's own unsent uploads. What is attached is its module's to answer for. */
export const requireOwnUpload: AttachmentReader = async (executor, userId, attachmentId) => {
  if (!Value.Check(Uuid, attachmentId)) throw attachmentNotFound();
  const row = await executor
    .selectFrom('attachments')
    .select([
      'attachments.id as id',
      'attachments.storage_key as storageKey',
      'attachments.thumbnail_key as thumbnailKey',
      'attachments.file_name as fileName',
      'attachments.kind as kind',
    ])
    .where('attachments.id', '=', attachmentId)
    .where((eb) => isUnsentUploadOf(eb, userId))
    .executeTakeFirst();
  if (row === undefined) throw attachmentNotFound();
  return row;
};
