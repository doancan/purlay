/**
 * Storing an upload (D-16, D-109 §3, §5): the object, then its row, unattached until a message
 * carries it.
 *
 * **The object is written outside the transaction**, so no pool connection waits on the store
 * (D-87); the transaction is only the check and the insert, under a lock on the workspace row, so two
 * uploads cannot both pass a quota that has room for one.
 *
 * **Every attempt writes its own key** — `w/<workspace>/<attachment id>/<random>` — and the row keeps
 * the key it was made with. Two attempts at one id (a retry racing itself, or somebody else's id)
 * therefore never write over each other's bytes; the one that loses deletes only its own object.
 * A delete that fails is logged as an error naming the key: an object no row points at is storage
 * nobody can reach, and it must be found.
 *
 * **A retry is the same upload.** The client chose the id (D-33's rule), so an id already held by
 * the same person, in the same workspace, with the same name and size, answers that attachment;
 * held by anybody else, or with other bytes, it is `ATTACHMENT_ID_CONFLICT`.
 *
 * **An image is stored as what `images.ts` makes of it** — WebP, and a thumbnail at `<key>.thumb` —
 * so the quota counts what is kept, not what was sent.
 */
import { sql } from '@purlay/db';
import {
  PENDING_UPLOADS_MAX,
  isMessageIdShape,
  type Attachment,
  type AttachmentKind,
} from '@purlay/types';
import { attachmentNotFound } from '../../platform/channels';
import { AppError } from '../../platform/errors';
import type { Logger } from '../../platform/logging';
import {
  claimUploadKeys,
  drainObjectDeletions,
  enqueueObjectDeletions,
  writeUploadKeysAhead,
} from './deletions';
import { workspacePrefix, type ObjectStore } from '../../platform/storage';
import type { WorkspaceContext } from '../../platform/tenancy';
import type { Atomically } from '../../platform/transactions';
import { readImage } from './images';
import { storageOf } from './quota';

export interface UploadDependencies {
  readonly atomically: Atomically;
  readonly storage: ObjectStore;
  readonly log: Logger;
}

export interface UploadInput {
  readonly id: string;
  readonly name: string;
  readonly bytes: Uint8Array;
}

interface Row {
  readonly id: string;
  readonly workspace_id: string;
  readonly uploader_id: string;
  readonly file_name: string;
  readonly mime_type: string;
  readonly size_bytes: string | number | bigint;
  readonly kind: AttachmentKind;
  readonly width: number | null;
  readonly height: number | null;
}

/** The contract's attachment for a row: one mapping, for the upload's answer and a message's. */
export const asAttachment = (row: Row): Attachment => ({
  id: row.id,
  fileName: row.file_name,
  mimeType: row.mime_type,
  sizeBytes: Number(row.size_bytes),
  kind: row.kind,
  width: row.width,
  height: row.height,
});

/**
 * The same upload: same person, same workspace, same name, and the same size as stored — for an
 * image, the size of its re-encoding, which the same bytes always give.
 */
const isRetryOf = (
  row: Row,
  context: WorkspaceContext,
  input: UploadInput,
  storedLength: number,
): boolean =>
  row.uploader_id === context.userId &&
  row.workspace_id === context.workspaceId &&
  row.file_name === input.name &&
  Number(row.size_bytes) === storedLength;

const conflict = (): AppError =>
  new AppError({
    code: 'ATTACHMENT_ID_CONFLICT',
    message: 'That attachment id is already used for another upload.',
  });

/** The columns `asAttachment` reads. */
export const ATTACHMENT_COLUMNS = [
  'id',
  'workspace_id',
  'uploader_id',
  'file_name',
  'mime_type',
  'size_bytes',
  'kind',
  'width',
  'height',
] as const;

export const storeUpload = async (
  dependencies: UploadDependencies,
  context: WorkspaceContext,
  input: UploadInput,
): Promise<{ readonly attachment: Attachment; readonly created: boolean }> => {
  const { atomically, storage, log } = dependencies;
  if (!isMessageIdShape(input.id)) {
    throw new AppError({
      code: 'VALIDATION_FAILED',
      message: 'An attachment id is a UUIDv7.',
      details: { fields: { id: 'a UUIDv7' } },
    });
  }

  // An image is stored as its re-encoding with a thumbnail beside it (or refused); the rest as sent.
  // Read first, so a retry is judged by what it would store.
  const image = await readImage(input.bytes);
  const stored = image === null ? input.bytes : image.bytes;

  // Answered before a byte is stored: the common retry costs the store nothing.
  const earlier = await atomically(
    async (transaction) =>
      await transaction
        .selectFrom('attachments')
        .select(ATTACHMENT_COLUMNS)
        .where('id', '=', input.id)
        .executeTakeFirst(),
  );
  if (earlier !== undefined) {
    if (!isRetryOf(earlier, context, input, stored.length)) throw conflict();
    return { attachment: asAttachment(earlier), created: false };
  }

  const key = `${workspacePrefix(context.workspaceId)}${input.id}/${crypto.randomUUID()}`;
  const thumbnailKey = image === null ? null : `${key}.thumb`;
  const keys = thumbnailKey === null ? [key] : [key, thumbnailKey];
  // Named before they exist (#607): a process that stops before the row is inserted leaves keys the
  // sweep will take, never objects nothing names.
  await atomically(async (transaction) => {
    await writeUploadKeysAhead(transaction, keys);
  });
  const letGo = async (): Promise<void> => {
    await drainObjectDeletions({ atomically, storage, log }, keys);
  };
  try {
    await storage.put(key, stored, image === null ? 'application/octet-stream' : 'image/webp');
    if (image !== null && thumbnailKey !== null) {
      await storage.put(thumbnailKey, image.thumbnail, 'image/webp');
    }
  } catch (error) {
    await letGo();
    throw error;
  }

  try {
    return await atomically(async (transaction) => {
      // Uploads into one workspace take turns from here, so its quota is checked once per byte.
      const kept = await storageOf(transaction, context.workspaceId, { lock: true });

      const raced = await transaction
        .selectFrom('attachments')
        .select(ATTACHMENT_COLUMNS)
        .where('id', '=', input.id)
        .executeTakeFirst();
      if (raced !== undefined) {
        if (!isRetryOf(raced, context, input, stored.length)) throw conflict();
        // The other attempt won; this one's object is not the row's, and goes below.
        return { attachment: asAttachment(raced), created: false, own: false };
      }

      const waiting = await transaction
        .selectFrom('attachments')
        .select(sql<string>`count(*)`.as('mine'))
        .where('workspace_id', '=', context.workspaceId)
        .where('uploader_id', '=', context.userId)
        .where('message_id', 'is', null)
        .where('scheduled_message_id', 'is', null)
        .executeTakeFirstOrThrow();
      if (Number(waiting.mine) >= PENDING_UPLOADS_MAX) {
        throw new AppError({
          code: 'TOO_MANY_PENDING_UPLOADS',
          message: `At most ${String(PENDING_UPLOADS_MAX)} files may wait to be sent.`,
        });
      }
      // The reading the owner is shown (`quota.ts`), so the two never disagree (D-173).
      const room = kept.quotaBytes - kept.usedBytes;
      if (BigInt(stored.length) > room) {
        // The room is said, so the person knows how large a file would still go (D-159): never
        // below nothing, and never more than a file may be, so it is a safe number on the wire.
        throw new AppError({
          code: 'STORAGE_QUOTA_EXCEEDED',
          message: 'This workspace has no room for that file.',
          details: { remainingBytes: room > 0n ? Number(room) : 0 },
        });
      }

      const row = await transaction
        .insertInto('attachments')
        .values({
          id: input.id,
          workspace_id: context.workspaceId,
          uploader_id: context.userId,
          storage_key: key,
          thumbnail_key: thumbnailKey,
          file_name: input.name,
          mime_type: image === null ? 'application/octet-stream' : 'image/webp',
          size_bytes: String(stored.length),
          kind: image === null ? 'file' : 'image',
          width: image?.width ?? null,
          height: image?.height ?? null,
        })
        .returning(ATTACHMENT_COLUMNS)
        .executeTakeFirstOrThrow();
      // The row names them now: no longer the queue's.
      await claimUploadKeys(transaction, keys);
      return { attachment: asAttachment(row), created: true, own: true };
    }).then(async (outcome) => {
      if (!outcome.own) await letGo();
      return { attachment: outcome.attachment, created: outcome.created };
    });
  } catch (error) {
    await letGo();
    throw error;
  }
};

/**
 * Deletes one of the person's own unsent uploads (D-109 §5): the row, then its objects once nothing
 * points at them. Anything else — sent, somebody else's, never there — is one refusal; a send that
 * links it first wins, and this finds nothing to delete.
 */
export const discardUpload = async (
  dependencies: UploadDependencies,
  userId: string,
  attachmentId: string,
): Promise<void> => {
  const { atomically, storage, log } = dependencies;
  if (!isMessageIdShape(attachmentId)) throw attachmentNotFound();
  const keys = await atomically(async (transaction) => {
    const gone = await transaction
      .deleteFrom('attachments')
      .where('id', '=', attachmentId)
      .where('uploader_id', '=', userId)
      .where('message_id', 'is', null)
      .where('scheduled_message_id', 'is', null)
      .returning(['storage_key', 'thumbnail_key'])
      .executeTakeFirst();
    if (gone === undefined) throw attachmentNotFound();
    const named =
      gone.thumbnail_key === null ? [gone.storage_key] : [gone.storage_key, gone.thumbnail_key];
    // Queued with the row's delete: one the store refuses is tried again (D-141).
    await enqueueObjectDeletions(transaction, named);
    return named;
  });
  await drainObjectDeletions({ atomically, storage, log }, keys);
};
