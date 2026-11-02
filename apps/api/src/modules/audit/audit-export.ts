/**
 * The trail as a file (D-222): what the Audit log page shows under the same filter, every entry of it,
 * newest first, as CSV for a spreadsheet or as NDJSON for a program.
 *
 * - **Streamed a page at a time.** The file is written as it is read, `AUDIT_EXPORT_PAGE` rows a query by
 *   keyset on the id, each page asked for only when the reader has taken the last one — so a trail of a
 *   million rows costs one page of memory and no connection is held between pages. The keyset walks down
 *   from the newest entry at the start, so what is written meanwhile is not in it and nothing is twice.
 * - **Recorded before the first byte**, as `audit.exported` with the format and the filter: an export
 *   cut off halfway was still an export. A filter that is refused is refused before it is recorded.
 * - **The first page is read before the answer**, so a database that fails at once is the one error
 *   envelope (`500 INTERNAL`); one that fails later ends the download unfinished — the connection is
 *   cut, which a browser shows as a failed download — and is logged by its code, never left looking whole.
 * - **A spreadsheet cannot be made to run a cell**: one that starts with `=`, `+`, `-`, `@`, a tab or a
 *   carriage return is prefixed with `'` (OWASP's CSV injection advice), and every cell is quoted as
 *   RFC 4180 says when it holds a quote, a comma or a line break. UTF-8 with a byte-order mark, which is
 *   what makes a spreadsheet read `ğ` and `ş` as themselves; lines end in CRLF.
 */
import type { Executor } from '@purlay/db';
import {
  AUDIT_EXPORT_COLUMNS,
  type AuditEntry,
  type AuditExportFormat,
  type AuditExportLine,
  type AuditExportQuery,
} from '@purlay/types';
import type { Clock } from '../../platform/clock';
import type { Logger } from '../../platform/logging';
import type { WorkspaceContext } from '../../platform/tenancy';
import { atomicallyOn } from '../../platform/transactions';
import { checkedFilter, recordAudit, requireTrailReader, trailPage } from './audit';

/** Rows a query of the download reads: a page of memory, and a few hundred round trips for 100 000. */
export const AUDIT_EXPORT_PAGE = 500;

/** What a spreadsheet would read as the start of a formula (OWASP, "CSV Injection"). */
const FORMULA_START = /^[=+\-@\t\r]/;

/** One CSV cell: defused, then quoted if it must be. Null is an empty cell. */
const csvCell = (value: string | null): string => {
  if (value === null) return '';
  const defused = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(defused) ? `"${defused.replaceAll('"', '""')}"` : defused;
};

/** An entry as the file says it: who acted by id and by name, since the file is read on its own. */
const exportLineOf = (entry: AuditEntry): AuditExportLine => ({
  id: entry.id,
  createdAt: entry.createdAt,
  action: entry.action,
  actorId: entry.actor?.id ?? null,
  actorUsername: entry.actor?.username ?? null,
  actorDisplayName: entry.actor?.displayName ?? null,
  targetType: entry.targetType,
  targetId: entry.targetId,
  metadata: entry.metadata,
});

const CRLF = '\r\n';
const BYTE_ORDER_MARK = '﻿';

const csvRow = (line: AuditExportLine): string =>
  AUDIT_EXPORT_COLUMNS.map((column) => {
    const value = line[column];
    return csvCell(typeof value === 'object' && value !== null ? JSON.stringify(value) : value);
  }).join(',') + CRLF;

/** How each format begins, says one entry, and is served. */
const FORMATS: Readonly<
  Record<
    AuditExportFormat,
    {
      readonly head: string;
      readonly line: (line: AuditExportLine) => string;
      readonly contentType: string;
    }
  >
> = {
  csv: {
    head: BYTE_ORDER_MARK + AUDIT_EXPORT_COLUMNS.join(',') + CRLF,
    line: csvRow,
    contentType: 'text/csv; charset=utf-8',
  },
  ndjson: {
    head: '',
    line: (line) => `${JSON.stringify(line)}\n`,
    contentType: 'application/x-ndjson; charset=utf-8',
  },
};

export interface TrailDownload {
  readonly body: ReadableStream<Uint8Array>;
  readonly contentType: string;
  /** `<slug>-audit-<day>.<format>`: the workspace's address, and the day it was made, in UTC. */
  readonly filename: string;
}

/** `GET /api/workspaces/:workspaceId/audit/export` — the narrowed trail, as a file (D-222). */
export const exportTrail = async (
  executor: Executor,
  clock: Clock,
  log: Logger,
  context: WorkspaceContext,
  query: AuditExportQuery,
): Promise<TrailDownload> => {
  requireTrailReader(context);
  const { format, ...filter } = query;
  checkedFilter(filter);
  await atomicallyOn(executor)(async (transaction) => {
    await recordAudit(transaction, clock, {
      workspaceId: context.workspaceId,
      actorUserId: context.userId,
      action: 'audit.exported',
      targetType: 'workspace',
      targetId: context.workspaceId,
      metadata: { format, ...filter },
    });
  });
  const workspace = await executor
    .selectFrom('workspaces')
    .select('slug')
    .where('id', '=', context.workspaceId)
    .executeTakeFirstOrThrow();
  const shape = FORMATS[format];
  const encoder = new TextEncoder();
  const read = async (before?: string): Promise<AuditEntry[]> =>
    await trailPage(executor, context, filter, {
      ...(before === undefined ? {} : { before }),
      limit: AUDIT_EXPORT_PAGE,
    });
  const chunkOf = (entries: readonly AuditEntry[], head = ''): Uint8Array =>
    encoder.encode(head + entries.map((entry) => shape.line(exportLineOf(entry))).join(''));

  // Read now, so a failure before the first byte is an answer and not a cut-off download.
  const first = await read();
  let pending: AuditEntry[] | null = first;
  let cursor = first.at(-1)?.id;
  let exhausted = first.length < AUDIT_EXPORT_PAGE;
  const body = new ReadableStream<Uint8Array>(
    {
      pull: async (controller): Promise<void> => {
        if (pending !== null) {
          controller.enqueue(chunkOf(pending, shape.head));
          pending = null;
          if (exhausted) controller.close();
          return;
        }
        try {
          const next = await read(cursor);
          cursor = next.at(-1)?.id ?? cursor;
          exhausted = next.length < AUDIT_EXPORT_PAGE;
          if (next.length > 0) controller.enqueue(chunkOf(next));
          if (exhausted) controller.close();
        } catch (error) {
          // Its code and where, never what the page held: the entries name people (§10).
          log.error('the audit log’s download failed partway', {
            workspaceId: context.workspaceId,
            err: error,
          });
          controller.error(error);
        }
      },
    },
    // Nothing is read ahead of the reader: a page is asked for when the last one has been taken.
    { highWaterMark: 0 },
  );
  return {
    body,
    contentType: shape.contentType,
    filename: `${workspace.slug}-audit-${clock.now().toISOString().slice(0, 10)}.${format}`,
  };
};
