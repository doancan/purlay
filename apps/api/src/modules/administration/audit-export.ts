import type { Executor } from '@purlay/db';
import {
  SERVER_AUDIT_EXPORT_COLUMNS,
  type ServerAuditEntry,
  type ServerAuditExportQuery,
} from '@purlay/types';
import type { Clock } from '../../platform/clock';
import type { Logger } from '../../platform/logging';
import { atomicallyOn } from '../../platform/transactions';
import type { ServerAdminSession } from '../setup/setup';
import type { TrailDownload } from '../audit/audit-export';
import { csvCell } from '../audit/csv';
import { recordServerAudit } from '../audit/server-audit';
import { listServerAudit } from './inventory';

const SERVER_AUDIT_EXPORT_PAGE = 100;

/** A page at a time, never read ahead, with current administration authority checked before each chunk. */
export const exportServerAudit = async (
  db: Executor,
  clock: Clock,
  log: Logger,
  query: ServerAuditExportQuery,
  authorize: () => Promise<ServerAdminSession>,
  signal?: AbortSignal,
): Promise<TrailDownload> => {
  const { format, ...filter } = query;
  const admin = await authorize();
  const first = await listServerAudit(db, admin, { ...filter, limit: SERVER_AUDIT_EXPORT_PAGE });
  await atomicallyOn(db)(async (tx) => {
    await recordServerAudit(tx, clock, {
      actorUserId: admin.userId,
      action: 'server.audit_export_requested',
    });
  });
  const encoder = new TextEncoder();
  const head = format === 'csv' ? `\uFEFF${SERVER_AUDIT_EXPORT_COLUMNS.join(',')}\r\n` : '';
  const line = (entry: ServerAuditEntry): string =>
    format === 'ndjson'
      ? `${JSON.stringify(entry)}\n`
      : `${SERVER_AUDIT_EXPORT_COLUMNS.map((column) => csvCell(entry[column])).join(',')}\r\n`;
  let pending: typeof first | null = first;
  let cursor = first.nextCursor;
  let cancelled = false;
  const stop = (controller: ReadableStreamDefaultController<Uint8Array>): boolean => {
    if (cancelled) return true;
    if (signal?.aborted) {
      controller.close();
      return true;
    }
    return false;
  };
  const body = new ReadableStream<Uint8Array>(
    {
      pull: async (controller): Promise<void> => {
        try {
          if (stop(controller)) return;
          const current = await authorize();
          if (stop(controller)) return;
          const page =
            pending ??
            (await listServerAudit(db, current, {
              ...filter,
              limit: SERVER_AUDIT_EXPORT_PAGE,
              ...(cursor === null ? {} : { after: cursor }),
            }));
          if (stop(controller)) return;
          const prefix = pending === null ? '' : head;
          pending = null;
          cursor = page.nextCursor;
          const text = prefix + page.data.map(line).join('');
          if (text !== '') controller.enqueue(encoder.encode(text));
          if (cursor === null) controller.close();
        } catch (error) {
          if (cancelled) return;
          log.error('server audit download failed partway', { err: error });
          controller.error(error);
        }
      },
      cancel: (): void => {
        cancelled = true;
        pending = null;
      },
    },
    { highWaterMark: 0 },
  );
  return {
    body,
    contentType:
      format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
    filename: `server-audit-${clock.now().toISOString().slice(0, 10)}.${format}`,
  };
};
