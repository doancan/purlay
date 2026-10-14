/**
 * A workspace export against the real database (D-27 §3, D-140). Two workspaces, every exported table
 * filled in both, a person in both, a direct message in the other one with somebody who is only there,
 * and a former member: the export of the first holds exactly the first's rows — not one id of the
 * second — every person its rows name and nobody else, a former member without the address or profile
 * they set after they left, and no secret anywhere in its bytes. The classification is bound to the
 * catalogue: a table or a column the database has and the export has not decided on fails here.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeIntegrationDatabase, sql, withRollback, type Transaction } from '@purlay/db';
import { ExportManifest, messageId } from '@purlay/types';
import { Value } from '@sinclair/typebox/value';
import { fixedClock } from '../../platform/clock';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { atomicallyOn } from '../../platform/transactions';
import { aRecordingLogger } from '../../testing/doubles';
import { aRoom, type Room } from '../../testing/rooms';
import { aMemoryStore } from '../../testing/storage';
import { storeUpload } from '../attachments/uploads';
import { recordAudit } from '../audit/audit';
import { sendMessage } from '../messages/messages';
import { everyChannel, exportWorkspace, TABLE_ORDER } from './export';
import { COLUMNS, EXCLUDED, MIGRATOR_TABLES, type ExportedTable } from './tables';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-10-14T12:00:00.000Z');
const clock = fixedClock(NOW);
let tick = 0;
const next = (): Date => new Date(NOW.getTime() + (tick += 1));

const member = (room: Room, name: string): NonNullable<Room['members'][string]> => {
  const found = room.members[name];
  if (found === undefined) throw new Error(`no member ${name}`);
  return found;
};

/** Every exported table given at least one row in this room's workspace; what to look for after. */
/** The files the fixture's attachments name, kept as the store would. */
let store = aMemoryStore();

const fill = async (
  db: Transaction,
  room: Room,
  as: string,
  other: string,
): Promise<{ secrets: string[]; ids: string[] }> => {
  const author = member(room, as);
  const where = { workspace_id: room.workspaceId, channel_id: room.channelId };
  const sent = await sendMessage(db, fixedClock(next()), author.context, {
    id: messageId(next()),
    content: `look @${member(room, other).username}`,
  });
  const id = sent.message.id;
  await db
    .insertInto('reactions')
    .values({ message_id: id, user_id: member(room, other).userId, emoji: '👍' })
    .execute();
  await db
    .insertInto('message_versions')
    .values({
      id: messageId(next()),
      ...where,
      message_id: id,
      content: 'before',
      replaced_at: next(),
    })
    .execute();
  await db
    .insertInto('pinned_messages')
    .values({ ...where, message_id: id, pinned_by: author.userId })
    .execute();
  // Stored as an upload is, so its key is the one production writes — not one a test made up (#84).
  const fileId = messageId(next());
  await storeUpload(
    { atomically: atomicallyOn(db), storage: store, log: aRecordingLogger().log },
    await requireWorkspaceMembership(db, author.userId, room.workspaceId),
    { id: fileId, name: 'plan.pdf', bytes: new Uint8Array(10).fill(7) },
  );
  const { storage_key: storageKey } = await db
    .updateTable('attachments')
    .set({ message_id: id, channel_id: room.channelId })
    .where('id', '=', fileId)
    .where('workspace_id', '=', room.workspaceId)
    .returning('storage_key')
    .executeTakeFirstOrThrow();
  const incident = messageId(next());
  await db
    .insertInto('incidents')
    .values({
      id: incident,
      ...where,
      severity: 2,
      declared_by: author.userId,
      declared_at: next(),
    })
    .execute();
  await db
    .insertInto('incident_updates')
    .values({
      id: messageId(next()),
      incident_id: incident,
      actor_id: author.userId,
      kind: 'declared',
      to_value: 'investigating',
      at: next(),
    })
    .execute();
  await db
    .insertInto('incident_responders')
    .values({
      incident_id: incident,
      channel_id: room.channelId,
      user_id: author.userId,
      added_by: author.userId,
      added_at: next(),
    })
    .execute();
  const feedSecret = `sealed-secret-${crypto.randomUUID()}`;
  await db
    .insertInto('github_repo_feeds')
    .values({
      id: messageId(next()),
      ...where,
      repository_id: Math.floor(Math.random() * 1e9),
      repository_full_name: `acme/${crypto.randomUUID().slice(0, 6)}`,
      events: ['push'],
      secret_encrypted: feedSecret,
      created_by: author.userId,
    })
    .execute();
  const tokenHash = (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');
  await db
    .insertInto('workspace_invitations')
    .values({
      id: messageId(next()),
      workspace_id: room.workspaceId,
      created_by: author.userId,
      token_hash: tokenHash,
      created_at: NOW,
      expires_at: new Date(NOW.getTime() + 86_400_000),
    })
    .execute();
  await recordAudit(db, clock, {
    workspaceId: room.workspaceId,
    actorUserId: author.userId,
    action: 'channel.created',
    targetType: 'channel',
    targetId: room.channelId,
  });
  return { secrets: [feedSecret, tokenHash, storageKey], ids: [id, fileId, incident] };
};

const lines = async (directory: string, table: ExportedTable): Promise<Record<string, unknown>[]> =>
  (await readFile(join(directory, `${table}.ndjson`), 'utf8'))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe('integration: exporting a workspace', () => {
  test('holds exactly its own rows, the people they name, and no secret', async () => {
    await withRollback(async (db) => {
      const a = await aRoom(db, ['pat', 'ann', 'fay']);
      const b = await aRoom(db, ['qui', 'pat2']);
      // pat is in both: b's second member row becomes pat's.
      const pat = member(a, 'pat');
      await db
        .updateTable('workspace_members')
        .set({ user_id: pat.userId })
        .where('user_id', '=', member(b, 'pat2').userId)
        .execute();
      await db
        .updateTable('channel_members')
        .set({ user_id: pat.userId })
        .where('user_id', '=', member(b, 'pat2').userId)
        .execute();
      // fay wrote in a, then left: a former member.
      const fay = member(a, 'fay');
      await sendMessage(db, fixedClock(next()), fay.context, {
        id: messageId(next()),
        content: 'before I go',
      });
      await db
        .updateTable('users')
        .set({ title: 'Set elsewhere, after', time_zone: 'Asia/Tokyo' })
        .where('id', '=', fay.userId)
        .execute();
      await db.deleteFrom('channel_members').where('user_id', '=', fay.userId).execute();
      await db.deleteFrom('workspace_members').where('user_id', '=', fay.userId).execute();
      const ours = await fill(db, a, 'pat', 'ann');
      const theirs = await fill(db, b, 'qui', 'pat2');

      const target = join(await mkdtemp(join(tmpdir(), 'purlay-export-')), 'acme');
      const workspace = await db
        .selectFrom('workspaces')
        .select(['id', 'slug', 'name'])
        .where('id', '=', a.workspaceId)
        .executeTakeFirstOrThrow();
      const { path, manifest } = await exportWorkspace(
        { database: db, clock, log: aRecordingLogger().log, storage: store },
        workspace,
        {
          kind: 'all',
          workspaceId: a.workspaceId,
          channelIds: await everyChannel(db, a.workspaceId),
        },
        target,
      );
      expect(path).toBe(target);
      expect(Value.Check(ExportManifest, manifest)).toBe(true);
      const onDisk = JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8')) as unknown;
      expect(onDisk).toEqual(manifest);

      // Every table written, each count its file's, and — the fixture's own check — none empty.
      const files = (await readdir(target)).sort();
      expect(files).toEqual(
        [...TABLE_ORDER.map((table) => `${table}.ndjson`), 'blobs', 'manifest.json'].sort(),
      );
      for (const table of TABLE_ORDER) {
        const rows = await lines(target, table);
        expect({ table, rows: rows.length }).toEqual({ table, rows: manifest.tables[table] ?? -1 });
        expect({ table, empty: rows.length === 0 }).toEqual({ table, empty: false });
        // Nothing of another workspace: any column naming one names this one.
        for (const row of rows) {
          if ('workspace_id' in row) expect(row['workspace_id']).toBe(a.workspaceId);
        }
      }

      // Not one byte of the other workspace's, and no secret of either.
      let everything = '';
      for (const file of files.filter(
        (name) => name.endsWith('.ndjson') || name.endsWith('.json'),
      )) {
        everything += await readFile(join(target, file), 'utf8');
      }
      for (const id of [...theirs.ids, b.workspaceId, b.channelId, member(b, 'qui').userId]) {
        expect({ id, found: everything.includes(id) }).toEqual({ id, found: false });
      }
      for (const secret of [...ours.secrets, ...theirs.secrets]) {
        expect({ secret, found: everything.includes(secret) }).toEqual({ secret, found: false });
      }
      for (const id of ours.ids) expect(everything).toContain(id);

      // People: current members with their address; fay without hers, or what she set after.
      const people = await lines(target, 'users');
      const byId = new Map(people.map((person) => [person['id'], person]));
      expect(byId.get(pat.userId)?.['email']).toEqual(expect.stringContaining('@'));
      expect(byId.get(fay.userId)).toMatchObject({ email: null, title: null, time_zone: null });
      expect(people.every((person) => !('github_id' in person) && !('locale' in person))).toBe(
        true,
      );

      // Owner-only, and the trail says it was exported, by nobody in the workspace.
      expect((await stat(target)).mode & 0o777).toBe(0o700);
      expect((await stat(join(target, 'messages.ndjson'))).mode & 0o777).toBe(0o600);
      expect(
        await db
          .selectFrom('audit_log')
          .select(['actor_user_id', 'metadata'])
          .where('workspace_id', '=', a.workspaceId)
          .where('action', '=', 'workspace.exported')
          .execute(),
      ).toEqual([
        {
          actor_user_id: null,
          metadata: { scope: 'all', messages: String(manifest.tables['messages']) },
        },
      ]);
    });
  });

  test('every person a row names is in the export: no reference dangles', async () => {
    await withRollback(async (db) => {
      const a = await aRoom(db, ['pat', 'ann']);
      await fill(db, a, 'pat', 'ann');
      const target = join(await mkdtemp(join(tmpdir(), 'purlay-export-')), 'out');
      const workspace = { id: a.workspaceId, slug: 'acme', name: 'Acme' };
      await exportWorkspace(
        { database: db, clock, log: aRecordingLogger().log, storage: store },
        workspace,
        {
          kind: 'all',
          workspaceId: a.workspaceId,
          channelIds: await everyChannel(db, a.workspaceId),
        },
        target,
      );
      const { rows } = await sql<{ table: string; column: string }>`
        select c.conrelid::regclass::text as table, a.attname as column
        from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
        where c.contype = 'f' and c.confrelid = 'users'::regclass
      `.execute(db);
      const named = new Set<string>();
      for (const { table, column } of rows) {
        if (!(table in COLUMNS)) continue;
        for (const row of await lines(target, table as ExportedTable)) {
          const value = row[column];
          if (typeof value === 'string') named.add(value);
        }
      }
      const people = new Set((await lines(target, 'users')).map((person) => person['id']));
      expect([...named].filter((id) => !people.has(id))).toEqual([]);
      expect(named.size).toBeGreaterThan(1);
    });
  });

  test('every table and every column of the catalogue is decided on', async () => {
    await withRollback(async (db) => {
      const { rows } = await sql<{ table: string; columns: string[] }>`
        select table_name as table, array_agg(column_name::text order by column_name) as columns
        from information_schema.columns where table_schema = 'public'
        group by table_name
      `.execute(db);
      // The migrator's own tables come and go with how it ran; everything else is decided.
      const decided = [...Object.keys(COLUMNS), ...Object.keys(EXCLUDED)];
      expect(
        rows
          .map((row) => row.table)
          .filter((table) => !MIGRATOR_TABLES.includes(table))
          .sort(),
      ).toEqual([...decided].sort());
      for (const row of rows) {
        if (!(row.table in COLUMNS)) continue;
        expect({ table: row.table, columns: row.columns }).toEqual({
          table: row.table,
          columns: Object.keys(COLUMNS[row.table as ExportedTable]).sort(),
        });
      }
    });
  });

  test('never writes over anything: a directory there already is refused', async () => {
    await withRollback(async (db) => {
      const a = await aRoom(db, ['pat']);
      const target = await mkdtemp(join(tmpdir(), 'purlay-export-'));
      const failure = await exportWorkspace(
        { database: db, clock, log: aRecordingLogger().log, storage: store },
        { id: a.workspaceId, slug: 'acme', name: 'Acme' },
        { kind: 'all', workspaceId: a.workspaceId, channelIds: [] },
        target,
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ body: { code: 'VALIDATION_FAILED' } });
    });
  });

  test('a scope of some channels holds those alone: another channel’s rows, and a foreign channel, are absent', async () => {
    await withRollback(async (db) => {
      const a = await aRoom(db, ['pat', 'ann']);
      const b = await aRoom(db, ['qui']);
      const pat = member(a, 'pat');
      // A private channel in a that the scope leaves out, with a message and a reaction in it.
      const hidden = await db
        .insertInto('channels')
        .values({
          workspace_id: a.workspaceId,
          name: 'hidden',
          type: 'private',
          created_by: pat.userId,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await db
        .insertInto('channel_members')
        .values({ channel_id: hidden.id, user_id: pat.userId, joined_at: NOW })
        .execute();
      const secret = await sendMessage(
        db,
        fixedClock(next()),
        { ...pat.context, channelId: hidden.id },
        { id: messageId(next()), content: 'only in hidden' },
      );
      await db
        .insertInto('reactions')
        .values({ message_id: secret.message.id, user_id: pat.userId, emoji: '🤫' })
        .execute();
      await fill(db, a, 'pat', 'ann');
      await fill(db, b, 'qui', 'qui');

      const target = join(await mkdtemp(join(tmpdir(), 'purlay-export-')), 'scoped');
      await exportWorkspace(
        { database: db, clock, log: aRecordingLogger().log, storage: store },
        { id: a.workspaceId, slug: 'acme', name: 'Acme' },
        // b's channel passed by mistake: it must select nothing.
        {
          kind: 'visible-to-owner',
          workspaceId: a.workspaceId,
          channelIds: [a.channelId, b.channelId],
        },
        target,
      );
      let everything = '';
      for (const file of await readdir(target)) {
        if (file !== 'blobs') everything += await readFile(join(target, file), 'utf8');
      }
      for (const id of [
        hidden.id,
        secret.message.id,
        b.channelId,
        b.workspaceId,
        member(b, 'qui').userId,
      ]) {
        expect({ id, found: everything.includes(id) }).toEqual({ id, found: false });
      }
      expect(everything).toContain(a.channelId);
      // An owner's export carries nobody's address (D-140 §3).
      const people = await lines(target, 'users');
      expect(people.length).toBeGreaterThan(0);
      expect(people.every((person) => person['email'] === null)).toBe(true);
    });
  });

  test('a directory whose parent is not there is refused', async () => {
    await withRollback(async (db) => {
      const a = await aRoom(db, ['pat']);
      const failure = await exportWorkspace(
        { database: db, clock, log: aRecordingLogger().log, storage: store },
        { id: a.workspaceId, slug: 'acme', name: 'Acme' },
        { kind: 'all', workspaceId: a.workspaceId, channelIds: [a.channelId] },
        join(tmpdir(), `purlay-no-such-${crypto.randomUUID()}`, 'out'),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ body: { code: 'VALIDATION_FAILED' } });
    });
  });

  test('a directory others may write into is refused, before anything is read', async () => {
    await withRollback(async (db) => {
      const a = await aRoom(db, ['pat']);
      const shared = await mkdtemp(join(tmpdir(), 'purlay-export-'));
      await chmod(shared, 0o777);
      const failure = await exportWorkspace(
        { database: db, clock, log: aRecordingLogger().log, storage: store },
        { id: a.workspaceId, slug: 'acme', name: 'Acme' },
        { kind: 'all', workspaceId: a.workspaceId, channelIds: [a.channelId] },
        join(shared, 'out'),
      ).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ body: { code: 'VALIDATION_FAILED' } });
      expect(await readdir(shared)).toEqual([]);
    });
  });

  describe('the files the attachments name', () => {
    const exported = async (
      db: Transaction,
      prepare: (room: Room) => Promise<void>,
    ): Promise<{ target: string; result: unknown; room: Room }> => {
      store = aMemoryStore();
      const room = await aRoom(db, ['pat', 'ann']);
      await fill(db, room, 'pat', 'ann');
      await prepare(room);
      const target = join(await mkdtemp(join(tmpdir(), 'purlay-export-')), 'out');
      const result = await exportWorkspace(
        { database: db, clock, log: aRecordingLogger().log, storage: store },
        { id: room.workspaceId, slug: 'acme', name: 'Acme' },
        { kind: 'all', workspaceId: room.workspaceId, channelIds: [room.channelId] },
        target,
      ).then(
        (done) => done,
        (error: unknown) => error,
      );
      return { target, result, room };
    };

    test('are copied, byte for byte, owner-only, and counted in the manifest', async () => {
      await withRollback(async (db) => {
        const { target, result } = await exported(db, () => Promise.resolve());
        const { manifest } = result as Awaited<ReturnType<typeof exportWorkspace>>;
        expect(manifest.blobs).toEqual({ count: 1, bytes: 10, removed: [], missing: [] });
        const [name] = await readdir(join(target, 'blobs'));
        const bytes = await readFile(join(target, 'blobs', name ?? ''));
        expect([...bytes]).toEqual(Array.from({ length: 10 }, () => 7));
        expect((await stat(join(target, 'blobs', name ?? ''))).mode & 0o777).toBe(0o600);
      });
    });

    test('one the store has not got, its row still there, is named missing; the export is still written', async () => {
      await withRollback(async (db) => {
        const { result } = await exported(db, async () => {
          for (const key of store.keys()) await store.delete(key);
        });
        const { manifest } = result as Awaited<ReturnType<typeof exportWorkspace>>;
        expect(manifest.blobs.missing).toHaveLength(1);
        expect(manifest.blobs.count).toBe(0);
      });
    });

    test('a store that refuses, a read cut off, or bytes not the row’s: no export, nothing left named as one', async () => {
      for (const [kind, error] of [
        ['get', new Error('the store is down')],
        ['stream', new Error('connection reset')],
      ] as const) {
        await withRollback(async (db) => {
          const { target, result } = await exported(db, () => {
            store.failing(kind, error);
            return Promise.resolve();
          });
          expect(result).toBe(error);
          expect(
            await stat(target).then(
              () => 'there',
              () => 'absent',
            ),
          ).toBe('absent');
        });
      }
      await withRollback(async (db) => {
        const { target, result } = await exported(db, async (room) => {
          await db
            .updateTable('attachments')
            .set({ size_bytes: '11' })
            .where('workspace_id', '=', room.workspaceId)
            .execute();
        });
        expect(String(result)).toContain('not the 11 its row says');
        expect(
          await stat(target).then(
            () => 'there',
            () => 'absent',
          ),
        ).toBe('absent');
      });
    });
  });
});
