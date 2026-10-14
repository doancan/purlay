/**
 * An owner's export of their workspace, over HTTP (D-140 §1): asked for (`202`, made in the background
 * by this process), listed, and downloaded once. The archive streams from the store to the browser and
 * leaves the store once it has been served whole.
 */
import type { Executor } from '@purlay/db';
import type { WorkspaceExport } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import type { Logger } from '../../platform/logging';
import type { ObjectStore } from '../../platform/storage';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { atomicallyOn } from '../../platform/transactions';
import {
  claimDownload,
  forgetArchive,
  listExports,
  requestExport,
} from '../../modules/export/requests';
import { requireSession } from './session';

export interface ExportDependencies {
  readonly database: Executor;
  readonly clock: Clock;
  readonly log: Logger;
  readonly storage: ObjectStore;
  /** Starts making an export once its request has committed: the process's queue (`exportQueue`). */
  readonly exportRunner: (exportId: string) => void;
}

/** `POST /api/workspaces/:workspaceId/exports` — asked for; its making starts once this commits. */
export const askForExport = async (
  dependencies: ExportDependencies,
  request: Request,
  workspaceId: string,
): Promise<WorkspaceExport> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  const asked = await atomicallyOn(database)(
    async (transaction) => await requestExport(transaction, clock, context),
  );
  // Not awaited: the answer does not wait for the export, which says how it went on its own row.
  dependencies.exportRunner(asked.id);
  return asked;
};

/** `GET /api/workspaces/:workspaceId/exports` — the newest ten. */
export const readExports = async (
  dependencies: ExportDependencies,
  request: Request,
  workspaceId: string,
): Promise<WorkspaceExport[]> => {
  const { database, clock } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  return await listExports(database, context);
};

/**
 * `GET /api/workspaces/:workspaceId/exports/:exportId/download` — once. The claim commits first, so a
 * second download — at the same moment or later — is `404 EXPORT_NOT_FOUND`; the archive leaves the
 * store when its last byte has been read.
 */
export const downloadExport = async (
  dependencies: ExportDependencies,
  request: Request,
  workspaceId: string,
  exportId: string,
): Promise<{
  readonly body: ReadableStream<Uint8Array>;
  readonly headers: Record<string, string>;
}> => {
  const { database, clock, log, storage } = dependencies;
  const { userId } = await requireSession(database, clock, request);
  const context = await requireWorkspaceMembership(database, userId, workspaceId);
  const { key, size } = await atomicallyOn(database)(
    async (transaction) => await claimDownload(transaction, clock, context, exportId),
  );
  // The archive goes when this download ends, however it ends: it was spent at the claim.
  const done = async (): Promise<void> => {
    try {
      await storage.delete(key);
      await forgetArchive(database, key);
    } catch (error) {
      // The row keeps its key: the sweep takes the archive.
      log.error('an export downloaded could not be removed from storage', { exportId, err: error });
    }
  };
  let stored: Awaited<ReturnType<ObjectStore['get']>>;
  try {
    stored = await storage.get(key);
  } catch (error) {
    await done();
    throw error;
  }
  if (stored === null) {
    await done();
    // Claimed while its archive is gone: our failure, loud, never "not found" (as an attachment's).
    throw new AppError({ code: 'INTERNAL', message: 'Something went wrong.' });
  }
  const workspace = await database
    .selectFrom('workspaces')
    .select('slug')
    .where('id', '=', workspaceId)
    .executeTakeFirstOrThrow();
  const name = `${workspace.slug}-export-${clock.now().toISOString().slice(0, 10)}.tar`;
  const reader = stored.body.getReader();
  const served = new ReadableStream<Uint8Array>({
    pull: async (controller): Promise<void> => {
      try {
        const { value, done: ended } = await reader.read();
        if (ended) {
          controller.close();
          await done();
        } else {
          controller.enqueue(value);
        }
      } catch (error) {
        log.warn('an export’s download was cut off by the store', { exportId, err: error });
        controller.error(error);
        await done();
      }
    },
    cancel: async (reason): Promise<void> => {
      // The browser went away: spent, and gone.
      log.warn('an export’s download was cancelled', { exportId });
      try {
        await reader.cancel(reason);
      } finally {
        await done();
      }
    },
  });
  return {
    body: served,
    headers: {
      'content-type': 'application/x-tar',
      'content-disposition': `attachment; filename="${name}"`,
      'content-length': String(size),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  };
};
