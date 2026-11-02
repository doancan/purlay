/**
 * The trail narrowed and taken away (D-222): filters applied by the server with the keyset intact, the
 * file it downloads as — whole, in pages, defused for a spreadsheet, in Turkish as written — and what
 * happens when the database fails partway or the trail grows while it is read.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import {
  AUDIT_EXPORT_COLUMNS,
  AuditExportLine,
  messageId,
  type AuditAction,
  type AuditExportQuery,
} from '@purlay/types';
import { fixedClock } from '../../platform/clock';
import { AppError } from '../../platform/errors';
import { NO_LOG } from '../../platform/events';
import { requireWorkspaceMembership, type WorkspaceContext } from '../../platform/tenancy';
import { aRecordingLogger } from '../../testing/doubles';
import { aRoom, type Room } from '../../testing/rooms';
import { auditTrail, recordAudit } from './audit';
import { AUDIT_EXPORT_PAGE, exportTrail } from './audit-export';
import { sendAuditLinesTo } from './lines';

afterAll(async () => {
  await closeIntegrationDatabase();
});

afterEach(() => {
  sendAuditLinesTo(NO_LOG);
});

const NOW = new Date('2026-10-31T12:00:00.000Z');
const clock = fixedClock(NOW);
const DAY = 86_400_000;

const idOf = (room: Room, name: string): string => {
  const found = room.members[name];
  if (found === undefined) throw new Error(`no ${name}`);
  return found.userId;
};

const contextOf = async (db: Executor, room: Room, name: string): Promise<WorkspaceContext> =>
  await requireWorkspaceMembership(db, idOf(room, name), room.workspaceId);

/** One entry, at an instant of its own. */
const entry = async (
  db: Executor,
  room: Room,
  at: number,
  actor: string,
  action: AuditAction = 'member.removed',
  metadata: Record<string, string> = {},
): Promise<void> => {
  await recordAudit(db, fixedClock(new Date(at)), {
    workspaceId: room.workspaceId,
    actorUserId: idOf(room, actor),
    action,
    targetType: 'user',
    targetId: idOf(room, actor),
    metadata,
  });
};

const refusalOf = async (work: Promise<unknown>): Promise<unknown> =>
  await work.then(
    () => 'not refused',
    (error: unknown) => (error instanceof AppError ? error.body : error),
  );

/** A download read to its end, as text — its byte-order mark kept, which `Response.text()` drops. */
const download = async (
  db: Executor,
  context: WorkspaceContext,
  query: AuditExportQuery,
): Promise<string> =>
  new TextDecoder('utf-8', { ignoreBOM: true }).decode(
    await new Response((await exportTrail(db, clock, NO_LOG, context, query)).body).arrayBuffer(),
  );

const ndjson = (text: string): Record<string, unknown>[] =>
  text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

/** Counts the reads of the trail, and fails the one numbered `failAt` — the database, at its seam. */
const watched = (
  db: Executor,
  failAt?: number,
): { readonly executor: Executor; readonly reads: () => number } => {
  let reads = 0;
  const executor: Executor = db.withPlugin({
    transformQuery: (args) => {
      if (args.node.kind === 'SelectQueryNode' && JSON.stringify(args.node).includes('audit_log')) {
        reads += 1;
        if (reads === failAt) throw new Error('the database went away');
      }
      return args.node;
    },
    transformResult: (args) => Promise.resolve(args.result),
  });
  return { executor, reads: () => reads };
};

describe('integration: the trail narrowed (D-222)', () => {
  test('by who acted, by action, and by a window of instants — from inclusive, to exclusive', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ayla', 'bora']);
      const start = NOW.getTime() - 3 * DAY;
      await entry(db, room, start - 1, 'ayla');
      await entry(db, room, start, 'bora', 'member.left');
      await entry(db, room, start + DAY, 'ayla', 'member.left');
      await entry(db, room, start + 2 * DAY - 1, 'bora');
      await entry(db, room, start + 2 * DAY, 'ayla');
      const ayla = await contextOf(db, room, 'ayla');
      const at = async (query: Parameters<typeof auditTrail>[2]): Promise<string[]> =>
        (await auditTrail(db, ayla, query)).data.map((e) => e.createdAt);
      const iso = (ms: number): string => new Date(ms).toISOString();

      expect(await at({ actorId: idOf(room, 'bora') })).toEqual([
        iso(start + 2 * DAY - 1),
        iso(start),
      ]);
      expect(await at({ action: 'member.left' })).toEqual([iso(start + DAY), iso(start)]);
      // The first instant of the window is in it; the last is the first one out.
      expect(await at({ from: iso(start), to: iso(start + 2 * DAY) })).toEqual([
        iso(start + 2 * DAY - 1),
        iso(start + DAY),
        iso(start),
      ]);
      expect(
        await at({ actorId: idOf(room, 'ayla'), action: 'member.left', from: iso(start) }),
      ).toEqual([iso(start + DAY)]);
      // An instant written in another zone is the same instant.
      expect(await at({ from: '2026-10-29T15:00:00.000+03:00', to: iso(start + 2 * DAY) })).toEqual(
        [iso(start + 2 * DAY - 1), iso(start + DAY)],
      );
    });
  });

  test('pages within the filter: a page, a page and one, exactly a page — never another row', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['cem', 'derya']);
      for (let step = 0; step < 10; step += 1) {
        await entry(db, room, NOW.getTime() - step * 1_000, step % 2 === 0 ? 'cem' : 'derya');
      }
      const cem = await contextOf(db, room, 'cem');
      const actorId = idOf(room, 'derya');
      const seen: string[] = [];
      let before: string | undefined;
      const sizes: number[] = [];
      do {
        const page = await auditTrail(db, cem, {
          actorId,
          limit: 2,
          ...(before === undefined ? {} : { before }),
        });
        sizes.push(page.data.length);
        seen.push(...page.data.map((e) => e.actor?.id ?? 'nobody'));
        before = page.nextCursor ?? undefined;
      } while (before !== undefined);
      expect(sizes).toEqual([2, 2, 1]);
      expect(seen).toEqual(Array.from({ length: 5 }, () => actorId));
      // Four that match, two a page: the second page is the last, and says so.
      const four = await auditTrail(db, cem, { actorId, limit: 4 });
      expect(four.data).toHaveLength(4);
      expect(four.nextCursor).not.toBeNull();
      const fifth = await auditTrail(db, cem, {
        actorId,
        limit: 4,
        before: four.nextCursor ?? '',
      });
      expect(fifth.data).toHaveLength(1);
      expect(fifth.nextCursor).toBeNull();
    });
  });

  test('a window that is empty, backwards or not a real moment is refused by the field it names', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['ece']);
      const ece = await contextOf(db, room, 'ece');
      const same = NOW.toISOString();
      expect(await refusalOf(auditTrail(db, ece, { from: same, to: same }))).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { fields: { to: 'must be after from' } },
      });
      expect(
        await refusalOf(auditTrail(db, ece, { from: same, to: '2026-10-30T00:00:00.000Z' })),
      ).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { fields: { to: 'must be after from' } },
      });
      // The contract's pattern lets these through; the calendar does not.
      expect(await refusalOf(auditTrail(db, ece, { from: '2026-02-31T00:00:00Z' }))).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { fields: { from: 'is not a real moment' } },
      });
      expect(await refusalOf(auditTrail(db, ece, { to: '2026-10-31T24:00:00Z' }))).toMatchObject({
        code: 'VALIDATION_FAILED',
        details: { fields: { to: 'is not a real moment' } },
      });
    });
  });

  test('never reaches another workspace: its person, named as the actor, is nobody here', async () => {
    await withRollback(async (db) => {
      const ours = await aRoom(db, ['filiz']);
      const theirs = await aRoom(db, ['gul']);
      await entry(db, ours, NOW.getTime(), 'filiz');
      await entry(db, theirs, NOW.getTime(), 'gul');
      const filiz = await contextOf(db, ours, 'filiz');
      expect((await auditTrail(db, filiz, { actorId: idOf(theirs, 'gul') })).data).toEqual([]);
      expect(
        ndjson(await download(db, filiz, { format: 'ndjson', actorId: idOf(theirs, 'gul') })),
      ).toEqual([]);
    });
  });

  test('a member reads none of it and downloads none of it, and their refusal is not recorded', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['hakan', 'irem']);
      const irem = await contextOf(db, room, 'irem');
      expect(await refusalOf(auditTrail(db, irem, {}))).toMatchObject({ code: 'FORBIDDEN' });
      expect(
        await refusalOf(exportTrail(db, clock, NO_LOG, irem, { format: 'csv' })),
      ).toMatchObject({ code: 'FORBIDDEN' });
      const rows = await db
        .selectFrom('audit_log')
        .select('id')
        .where('workspace_id', '=', room.workspaceId)
        .execute();
      expect(rows).toEqual([]);
    });
  });
});

describe('integration: the trail downloaded (D-222)', () => {
  test('as CSV: a byte-order mark, the header, CRLF, quoted where it must be, formulas defused, Turkish intact', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['jale', 'kaan']);
      await db
        .updateTable('users')
        .set({ display_name: '=HYPERLINK("http://x","Şükrü, Çağrı")' })
        .where('id', '=', idOf(room, 'kaan'))
        .execute();
      await entry(db, room, NOW.getTime() - 2_000, 'kaan', 'workspace.renamed', {
        from: 'Gizli İş',
        to: '+cmd|ğüşöç',
      });
      const jale = await contextOf(db, room, 'jale');
      const download_ = await exportTrail(db, clock, NO_LOG, jale, { format: 'csv' });
      expect(download_.contentType).toBe('text/csv; charset=utf-8');
      expect(download_.filename).toMatch(/^room-.+-audit-2026-10-31\.csv$/);
      const bytes = new Uint8Array(await new Response(download_.body).arrayBuffer());
      expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
      const text = new TextDecoder().decode(bytes.slice(3));
      const [header, ...rows] = text.split('\r\n');
      expect(header).toBe(AUDIT_EXPORT_COLUMNS.join(','));
      // The download's own entry first — it is on the trail before the first byte — then the rename.
      expect(rows.at(-1)).toBe('');
      const renamed = rows.find((row) => row.includes('workspace.renamed')) ?? '';
      expect(renamed).toContain(`"'=HYPERLINK(""http://x"",""Şükrü, Çağrı"")"`);
      expect(renamed).toContain('ğüşöç');
      expect(renamed).toContain('Gizli İş');
      expect(rows.filter((row) => row !== '')).toHaveLength(2);
    });
  });

  test('as NDJSON: one line per entry, each the contract’s, newest first, the download itself recorded first', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['leyla', 'mert']);
      await entry(db, room, NOW.getTime() - 2_000, 'mert', 'member.left');
      await entry(db, room, NOW.getTime() - 1_000, 'leyla', 'member.removed');
      const leyla = await contextOf(db, room, 'leyla');
      const lines = ndjson(await download(db, leyla, { format: 'ndjson' }));
      expect(lines.every((line) => Value.Check(AuditExportLine, line))).toBe(true);
      expect(lines.map((line) => line['action'])).toEqual([
        'audit.exported',
        'member.removed',
        'member.left',
      ]);
      expect(lines[0]).toMatchObject({
        actorId: idOf(room, 'leyla'),
        targetType: 'workspace',
        targetId: room.workspaceId,
        metadata: { format: 'ndjson' },
      });
    });
  });

  test('records who downloaded what, with the filter, before a byte is read; a refused filter records nothing', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['nil', 'okan']);
      const nil = await contextOf(db, room, 'nil');
      const recorded = async (): Promise<unknown[]> =>
        await db
          .selectFrom('audit_log')
          .select(['actor_user_id', 'action', 'metadata'])
          .where('workspace_id', '=', room.workspaceId)
          .where('action', '=', 'audit.exported')
          .execute();
      expect(
        await refusalOf(
          exportTrail(db, clock, NO_LOG, nil, {
            format: 'csv',
            from: NOW.toISOString(),
            to: NOW.toISOString(),
          }),
        ),
      ).toMatchObject({ code: 'VALIDATION_FAILED' });
      expect(await recorded()).toEqual([]);
      const { log, lines } = aRecordingLogger();
      sendAuditLinesTo(log);
      // Asked for and never read: an export that was started is on the trail.
      await exportTrail(db, clock, NO_LOG, nil, {
        format: 'csv',
        actorId: idOf(room, 'okan'),
        action: 'member.left',
        from: '2026-10-01T00:00:00.000Z',
      });
      expect(await recorded()).toEqual([
        {
          actor_user_id: idOf(room, 'nil'),
          action: 'audit.exported',
          metadata: {
            format: 'csv',
            actorId: idOf(room, 'okan'),
            action: 'member.left',
            from: '2026-10-01T00:00:00.000Z',
          },
        },
      ]);
      // Its line, too: ids only — the filter's person by id, never the date or a name.
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        audit: {
          action: 'audit.exported',
          actorId: idOf(room, 'nil'),
          workspaceId: room.workspaceId,
          relatedIds: { actorId: idOf(room, 'okan') },
        },
      });
    });
  });

  test(`streams ${String(2 * AUDIT_EXPORT_PAGE + 1)} entries a page at a time: none read ahead, none twice, none lost`, async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['pinar']);
      const total = 2 * AUDIT_EXPORT_PAGE + 1;
      const actor = idOf(room, 'pinar');
      await db
        .insertInto('audit_log')
        .values(
          Array.from({ length: total }, (_, n) => {
            const at = new Date(NOW.getTime() - (n + 1) * 1_000);
            return {
              id: messageId(at),
              workspace_id: room.workspaceId,
              actor_user_id: actor,
              action: 'member.removed',
              target_type: 'user',
              target_id: actor,
              metadata: JSON.stringify({}),
              created_at: at,
            };
          }),
        )
        .execute();
      const { executor, reads } = watched(db);
      const pinar = await contextOf(db, room, 'pinar');
      const { body } = await exportTrail(executor, clock, NO_LOG, pinar, { format: 'ndjson' });
      // The first page only, before anybody reads.
      expect(reads()).toBe(1);
      const lines = ndjson(await new Response(body).text());
      // Its own entry and the rest: two full pages and a short one, which says it is the end.
      expect(lines).toHaveLength(total + 1);
      expect(new Set(lines.map((line) => line['id'])).size).toBe(total + 1);
      const ids = lines.map((line) => String(line['id']));
      expect(ids).toEqual([...ids].sort().reverse());
      expect(reads()).toBe(Math.ceil((total + 1) / AUDIT_EXPORT_PAGE));
    });
  });

  test('zero entries the filter keeps is a header alone, or an empty file', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['rana']);
      const rana = await contextOf(db, room, 'rana');
      const nothing = { action: 'storage.quota_changed' } as const;
      expect(await download(db, rana, { format: 'csv', ...nothing })).toBe(
        `﻿${AUDIT_EXPORT_COLUMNS.join(',')}\r\n`,
      );
      expect(await download(db, rana, { format: 'ndjson', ...nothing })).toBe('');
    });
  });

  test('what is written while it is read is not in it; two at once are each whole', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['selin']);
      for (let n = 0; n < AUDIT_EXPORT_PAGE + 1; n += 1) {
        await entry(db, room, NOW.getTime() - (n + 1) * 1_000, 'selin');
      }
      const selin = await contextOf(db, room, 'selin');
      const started = await exportTrail(db, clock, NO_LOG, selin, { format: 'ndjson' });
      // Newer than everything, written between the first page and the second.
      await entry(db, room, NOW.getTime() + 60_000, 'selin', 'member.left');
      const lines = ndjson(await new Response(started.body).text());
      expect(lines.map((line) => line['action'])).not.toContain('member.left');
      expect(new Set(lines.map((line) => line['id'])).size).toBe(lines.length);

      const [one, two] = await Promise.all([
        download(db, selin, { format: 'ndjson', action: 'member.removed' }),
        download(db, selin, { format: 'ndjson', action: 'member.removed' }),
      ]);
      expect(ndjson(one)).toHaveLength(AUDIT_EXPORT_PAGE + 1);
      expect(one).toBe(two);
    });
  });

  test('a database failing before the first byte is the error; failing later cuts the file off, logged by where', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['tuna']);
      for (let n = 0; n < AUDIT_EXPORT_PAGE; n += 1) {
        await entry(db, room, NOW.getTime() - (n + 1) * 1_000, 'tuna');
      }
      const tuna = await contextOf(db, room, 'tuna');
      const early = watched(db, 1);
      expect(
        await exportTrail(early.executor, clock, NO_LOG, tuna, { format: 'csv' }).then(
          () => 'answered',
          (error: unknown) => (error as Error).message,
        ),
      ).toBe('the database went away');

      const { log, lines } = aRecordingLogger();
      const late = watched(db, 2);
      const { body } = await exportTrail(late.executor, clock, log, tuna, { format: 'csv' });
      const reader = body.getReader();
      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(
        await reader.read().then(
          () => 'whole',
          (error: unknown) => (error as Error).message,
        ),
      ).toBe('the database went away');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        level: 'error',
        msg: 'the audit log’s download failed partway',
        workspaceId: room.workspaceId,
      });
    });
  });

  test('a reader that goes away stops the reading', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['umut']);
      for (let n = 0; n < AUDIT_EXPORT_PAGE + 1; n += 1) {
        await entry(db, room, NOW.getTime() - (n + 1) * 1_000, 'umut');
      }
      const umut = await contextOf(db, room, 'umut');
      const { executor, reads } = watched(db);
      const reader = (
        await exportTrail(executor, clock, NO_LOG, umut, { format: 'csv' })
      ).body.getReader();
      await reader.read();
      await reader.cancel();
      expect(reads()).toBe(1);
    });
  });
});
