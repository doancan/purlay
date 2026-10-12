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
import { AppError } from '../../platform/errors';
import type { Logger } from '../../platform/logging';
import type { ObjectStore } from '../../platform/storage';
import type { WorkspaceContext } from '../../platform/tenancy';
import type { Atomically } from '../../platform/transactions';
import { readImage } from './images';

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

  const key = `w/${context.workspaceId}/${input.id}/${crypto.randomUUID()}`;
  const thumbnailKey = image === null ? null : `${key}.thumb`;
  const keys = thumbnailKey === null ? [key] : [key, thumbnailKey];
  await storage.put(key, stored, image === null ? 'application/octet-stream' : 'image/webp');
  if (image !== null && thumbnailKey !== null) {
    try {
      await storage.put(thumbnailKey, image.thumbnail, 'image/webp');
    } catch (error) {
      await removeLeftovers(storage, log, [key]);
      throw error;
    }
  }

  try {
    return await atomically(async (transaction) => {
      // Uploads into one workspace take turns from here, so its quota is checked once per byte.
      const workspace = await transaction
        .selectFrom('workspaces')
        .select(['storage_quota_bytes', 'storage_used_bytes'])
        .where('id', '=', context.workspaceId)
        .forUpdate()
        .executeTakeFirstOrThrow();

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
        .select([
          sql<string>`count(*) filter (where uploader_id = ${context.userId})`.as('mine'),
          sql<string>`coalesce(sum(size_bytes), 0)`.as('bytes'),
        ])
        .where('workspace_id', '=', context.workspaceId)
        .where('message_id', 'is', null)
        .executeTakeFirstOrThrow();
      if (Number(waiting.mine) >= PENDING_UPLOADS_MAX) {
        throw new AppError({
          code: 'TOO_MANY_PENDING_UPLOADS',
          message: `At most ${String(PENDING_UPLOADS_MAX)} files may wait to be sent.`,
        });
      }
      // BIGINT arrives as text: summed as integers, never as strings.
      const total =
        BigInt(workspace.storage_used_bytes) + BigInt(waiting.bytes) + BigInt(stored.length);
      if (total > BigInt(workspace.storage_quota_bytes)) {
        throw new AppError({
          code: 'STORAGE_QUOTA_EXCEEDED',
          message: 'This workspace has no room for that file.',
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
      return { attachment: asAttachment(row), created: true, own: true };
    }).then(async (outcome) => {
      if (!outcome.own) await removeLeftovers(storage, log, keys);
      return { attachment: outcome.attachment, created: outcome.created };
    });
  } catch (error) {
    await removeLeftovers(storage, log, keys);
    throw error;
  }
};

/** Deletes objects no row points at; one that cannot be deleted is reported, never dropped. */
const removeLeftovers = async (
  storage: ObjectStore,
  log: Logger,
  keys: readonly string[],
): Promise<void> => {
  for (const key of keys) {
    try {
      await storage.delete(key);
    } catch (error) {
      log.error('an upload’s object was left behind', { key, error });
    }
  }
};
