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
import {
  closeIntegrationDatabase,
  sql,
  withRollback,
  type Database,
  type Transaction,
} from '@purlay/db';
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
import { sendMessage } from '../../features/chat/messages/messages';
import { exportWorkspace, schemaOf } from './export';
import { everyChannel } from '../../features/chat/export';
import { MIGRATOR_TABLES } from './tables';
import { EVERY_TABLE_DECIDED, EXCLUDED_FROM_EXPORT, exportCatalogue } from '../../export-catalogue';
import { linkFile } from '../../testing/sent-files';

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
  await db
    .insertInto('channel_bookmarks')
    .values({
      id: messageId(next()),
      ...where,
      url: 'https://docs.example.com/runbook',
      title: 'Runbook',
      added_by: member(room, other).userId,
    })
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
  await linkFile(db, {
    id: fileId,
    workspaceId: room.workspaceId,
    messageId: id,
    channelId: room.channelId,
  });
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
  // The GitHub work the root points at (D-246): the channel's own record, in the export.
  await db
    .insertInto('github_links')
    .values({
      id: messageId(next()),
      ...where,
      root_id: id,
      repository_id: 77,
      repository_full_name: 'acme/api',
      kind: 'issue',
      number: 12,
      title: 'Retry with jitter',
      state: 'open',
      state_at: next(),
      origin: 'created',
      created_by: author.userId,
      created_at: next(),
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

const lines = async (directory: string, table: string): Promise<Record<string, unknown>[]> =>
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
        {
          catalogue: exportCatalogue,
          database: db,
          clock,
          log: aRecordingLogger().log,
          storage: store,
        },
        workspace,
        {
          kind: 'all',
          workspaceId: a.workspaceId,
          prepared: { chat: await everyChannel(db, a.workspaceId) },
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
        [
          ...exportCatalogue.order.map((table) => `${table}.ndjson`),
          'blobs',
          'manifest.json',
        ].sort(),
      );
      for (const table of exportCatalogue.order) {
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
      expect(
        people.every(
          (person) =>
            !('github_id' in person) && !('github_login' in person) && !('locale' in person),
        ),
      ).toBe(true);

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
        {
          catalogue: exportCatalogue,
          database: db,
          clock,
          log: aRecordingLogger().log,
          storage: store,
        },
        workspace,
        {
          kind: 'all',
          workspaceId: a.workspaceId,
          prepared: { chat: await everyChannel(db, a.workspaceId) },
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
        if (!exportCatalogue.order.some((name) => name === table)) continue;
        for (const row of await lines(target, table)) {
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
    // The compile-time half: the composition root does not compile while a table of the schema is undecided.
    expect(EVERY_TABLE_DECIDED).toBe(true);
    await withRollback(async (db) => {
      const { rows } = await sql<{ table: string; columns: string[] }>`
        select table_name as table, array_agg(column_name::text order by column_name) as columns
        from information_schema.columns where table_schema = 'public'
        group by table_name
      `.execute(db);
      // The migrator's own tables come and go with how it ran; everything else is decided.
      const decided = [...exportCatalogue.order, ...Object.keys(EXCLUDED_FROM_EXPORT)];
      expect(
        rows
          .map((row) => row.table)
          .filter((table) => !MIGRATOR_TABLES.includes(table))
          .sort(),
      ).toEqual([...decided].sort());
      for (const row of rows) {
        if (!exportCatalogue.order.some((name) => name === row.table)) continue;
        expect({ table: row.table, columns: row.columns }).toEqual({
          table: row.table,
          columns: Object.keys(exportCatalogue.table(row.table as keyof Database).columns).sort(),
        });
      }
    });
  });

  test('never writes over anything: a directory there already is refused', async () => {
    await withRollback(async (db) => {
      const a = await aRoom(db, ['pat']);
      const target = await mkdtemp(join(tmpdir(), 'purlay-export-'));
      const failure = await exportWorkspace(
        {
          catalogue: exportCatalogue,
          database: db,
          clock,
          log: aRecordingLogger().log,
          storage: store,
        },
        { id: a.workspaceId, slug: 'acme', name: 'Acme' },
        { kind: 'all', workspaceId: a.workspaceId, prepared: { chat: [] } },
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
      const hiddenFile = messageId(next());
      await storeUpload(
        { atomically: atomicallyOn(db), storage: store, log: aRecordingLogger().log },
        await requireWorkspaceMembership(db, pat.userId, a.workspaceId),
        { id: hiddenFile, name: 'hidden.txt', bytes: new Uint8Array(3).fill(5) },
      );
      const secret = await sendMessage(
        db,
        fixedClock(next()),
        { ...pat.context, channelId: hidden.id },
        { id: messageId(next()), content: 'only in hidden', attachmentIds: [hiddenFile] },
      );
      await db
        .insertInto('reactions')
        .values({ message_id: secret.message.id, user_id: pat.userId, emoji: '🤫' })
        .execute();
      await fill(db, a, 'pat', 'ann');
      await fill(db, b, 'qui', 'qui');

      const target = join(await mkdtemp(join(tmpdir(), 'purlay-export-')), 'scoped');
      await exportWorkspace(
        {
          catalogue: exportCatalogue,
          database: db,
          clock,
          log: aRecordingLogger().log,
          storage: store,
        },
        { id: a.workspaceId, slug: 'acme', name: 'Acme' },
        // b's channel passed by mistake: it must select nothing.
        {
          kind: 'visible-to-owner',
          workspaceId: a.workspaceId,
          prepared: { chat: [a.channelId, b.channelId] },
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
        hiddenFile,
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
        {
          catalogue: exportCatalogue,
          database: db,
          clock,
          log: aRecordingLogger().log,
          storage: store,
        },
        { id: a.workspaceId, slug: 'acme', name: 'Acme' },
        { kind: 'all', workspaceId: a.workspaceId, prepared: { chat: [a.channelId] } },
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
        {
          catalogue: exportCatalogue,
          database: db,
          clock,
          log: aRecordingLogger().log,
          storage: store,
        },
        { id: a.workspaceId, slug: 'acme', name: 'Acme' },
        { kind: 'all', workspaceId: a.workspaceId, prepared: { chat: [a.channelId] } },
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
        {
          catalogue: exportCatalogue,
          database: db,
          clock,
          log: aRecordingLogger().log,
          storage: store,
        },
        { id: room.workspaceId, slug: 'acme', name: 'Acme' },
        { kind: 'all', workspaceId: room.workspaceId, prepared: { chat: [room.channelId] } },
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

describe('integration: the schema an export is stamped with', () => {
  test('is the core’s last migration, whatever a module has recorded (D-250)', async () => {
    await withRollback(async (db) => {
      const before = await schemaOf(db);
      await sql`insert into kysely_migration (name, timestamp, checksum)
        values ('zz-module/9999_later', '2099-01-01T00:00:00.000Z', repeat('0', 64))`.execute(db);
      expect(await schemaOf(db)).toBe(before);
    });
  });
});

/**
 * The shape of what an export writes, held still so that moving the catalogue between modules (D-250) cannot
 * change a file unseen: the files in their order, and for each table how many rows the fixture gives it and
 * the columns of those rows. The values are random or time-bound; the shape is not. The operator's export and
 * an owner's differ only where a bound or a column says they do.
 */
const shapeOf = async (directory: string): Promise<Record<string, unknown>> => {
  const shape: Record<string, unknown> = {};
  for (const table of exportCatalogue.order) {
    const rows = await lines(directory, table);
    shape[table] = { rows: rows.length, columns: Object.keys(rows[0] ?? {}).sort() };
  }
  return { files: (await readdir(directory)).sort(), tables: shape };
};

describe('integration: the shape of an export', () => {
  test('is the one the catalogue has always written, for the operator and for an owner', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['pat', 'ann']);
      await fill(db, room, 'pat', 'ann');
      const workspace = await db
        .selectFrom('workspaces')
        .select(['id', 'slug', 'name'])
        .where('id', '=', room.workspaceId)
        .executeTakeFirstOrThrow();
      const shapes: Record<string, unknown> = {};
      for (const kind of ['all', 'visible-to-owner'] as const) {
        const target = join(await mkdtemp(join(tmpdir(), 'purlay-shape-')), kind);
        await exportWorkspace(
          {
            catalogue: exportCatalogue,
            database: db,
            clock,
            log: aRecordingLogger().log,
            storage: store,
          },
          workspace,
          {
            kind,
            workspaceId: room.workspaceId,
            prepared: { chat: await everyChannel(db, room.workspaceId) },
          },
          target,
        );
        shapes[kind] = await shapeOf(target);
      }
      expect(shapes).toEqual(FROZEN_SHAPES);
    });
  });
});

/**
 * As written when this test was made, by the catalogue before it moved between modules. A change that is meant
 * says so by changing this, in the same pull request, with the reason. (`audit_log` has one row more in the
 * second export: the first records that it was made.)
 */
const FROZEN_SHAPES: Record<string, unknown> = {
  all: {
    files: [
      'attachments.ndjson',
      'audit_log.ndjson',
      'blobs',
      'channel_bookmarks.ndjson',
      'channel_members.ndjson',
      'channels.ndjson',
      'github_links.ndjson',
      'github_repo_feeds.ndjson',
      'incident_responders.ndjson',
      'incident_updates.ndjson',
      'incidents.ndjson',
      'manifest.json',
      'mentions.ndjson',
      'message_versions.ndjson',
      'messages.ndjson',
      'pinned_messages.ndjson',
      'reactions.ndjson',
      'users.ndjson',
      'workspace_invitations.ndjson',
      'workspace_members.ndjson',
      'workspaces.ndjson',
    ],
    tables: {
      workspaces: {
        rows: 1,
        columns: [
          'avatar_url',
          'created_at',
          'created_by',
          'deleted_at',
          'id',
          'name',
          'retention_days',
          'slug',
          'storage_quota_bytes',
          'storage_used_bytes',
          'updated_at',
        ],
      },
      users: {
        rows: 2,
        columns: [
          'avatar_url',
          'created_at',
          'deleted_at',
          'display_name',
          'email',
          'id',
          'status_text',
          'time_zone',
          'title',
          'username',
        ],
      },
      workspace_members: {
        rows: 2,
        columns: ['id', 'joined_at', 'role', 'user_id', 'workspace_id'],
      },
      channels: {
        rows: 1,
        columns: [
          'created_at',
          'created_by',
          'deleted_at',
          'dm_key',
          'id',
          'last_message_at',
          'min_retention_days',
          'name',
          'only_admins_post',
          'retain_forever',
          'topic',
          'type',
          'updated_at',
          'workspace_id',
        ],
      },
      channel_members: {
        rows: 2,
        columns: ['channel_id', 'id', 'joined_at', 'user_id'],
      },
      messages: {
        rows: 1,
        columns: [
          'accepted_answer_id',
          'channel_id',
          'content',
          'created_at',
          'decision_note',
          'decision_updated_by',
          'decision_url',
          'deleted_at',
          'edited_at',
          'id',
          'is_question',
          'message_type',
          'metadata',
          'parent_id',
          'question_assignee_id',
          'resolved_at',
          'resolved_by',
          'sender_id',
          'thread_last_reply_at',
          'thread_reply_count',
          'updated_at',
          'workspace_id',
        ],
      },
      reactions: {
        rows: 1,
        columns: ['created_at', 'emoji', 'id', 'message_id', 'user_id'],
      },
      mentions: {
        rows: 1,
        columns: [
          'channel_id',
          'created_at',
          'id',
          'mentioned_user_id',
          'message_id',
          'workspace_id',
        ],
      },
      message_versions: {
        rows: 1,
        columns: ['channel_id', 'content', 'id', 'message_id', 'replaced_at', 'workspace_id'],
      },
      pinned_messages: {
        rows: 1,
        columns: ['channel_id', 'message_id', 'pinned_at', 'pinned_by', 'workspace_id'],
      },
      channel_bookmarks: {
        rows: 1,
        columns: ['added_at', 'added_by', 'channel_id', 'id', 'title', 'url', 'workspace_id'],
      },
      attachments: {
        rows: 1,
        columns: [
          'channel_id',
          'created_at',
          'file_name',
          'height',
          'id',
          'kind',
          'message_id',
          'mime_type',
          'size_bytes',
          'uploader_id',
          'width',
          'workspace_id',
        ],
      },
      incidents: {
        rows: 1,
        columns: [
          'channel_id',
          'declared_at',
          'declared_by',
          'id',
          'postmortem',
          'postmortem_version',
          'resolved_at',
          'runbook_url',
          'severity',
          'status',
          'workspace_id',
        ],
      },
      incident_updates: {
        rows: 1,
        columns: ['actor_id', 'at', 'from_value', 'id', 'incident_id', 'kind', 'to_value'],
      },
      incident_responders: {
        rows: 1,
        columns: ['added_at', 'added_by', 'channel_id', 'incident_id', 'user_id'],
      },
      github_repo_feeds: {
        rows: 1,
        columns: [
          'channel_id',
          'created_at',
          'created_by',
          'events',
          'id',
          'last_delivery_at',
          'last_failure',
          'last_failure_at',
          'repository_full_name',
          'repository_id',
          'workspace_id',
        ],
      },
      github_links: {
        rows: 1,
        columns: [
          'channel_id',
          'created_at',
          'created_by',
          'id',
          'kind',
          'number',
          'origin',
          'repository_full_name',
          'repository_id',
          'root_id',
          'state',
          'state_at',
          'title',
          'workspace_id',
        ],
      },
      workspace_invitations: {
        rows: 1,
        columns: ['created_at', 'created_by', 'expires_at', 'id', 'revoked_at', 'workspace_id'],
      },
      audit_log: {
        rows: 1,
        columns: [
          'action',
          'actor_user_id',
          'created_at',
          'id',
          'metadata',
          'target_id',
          'target_type',
          'workspace_id',
        ],
      },
    },
  },
  'visible-to-owner': {
    files: [
      'attachments.ndjson',
      'audit_log.ndjson',
      'blobs',
      'channel_bookmarks.ndjson',
      'channel_members.ndjson',
      'channels.ndjson',
      'github_links.ndjson',
      'github_repo_feeds.ndjson',
      'incident_responders.ndjson',
      'incident_updates.ndjson',
      'incidents.ndjson',
      'manifest.json',
      'mentions.ndjson',
      'message_versions.ndjson',
      'messages.ndjson',
      'pinned_messages.ndjson',
      'reactions.ndjson',
      'users.ndjson',
      'workspace_invitations.ndjson',
      'workspace_members.ndjson',
      'workspaces.ndjson',
    ],
    tables: {
      workspaces: {
        rows: 1,
        columns: [
          'avatar_url',
          'created_at',
          'created_by',
          'deleted_at',
          'id',
          'name',
          'retention_days',
          'slug',
          'storage_quota_bytes',
          'storage_used_bytes',
          'updated_at',
        ],
      },
      users: {
        rows: 2,
        columns: [
          'avatar_url',
          'created_at',
          'deleted_at',
          'display_name',
          'email',
          'id',
          'status_text',
          'time_zone',
          'title',
          'username',
        ],
      },
      workspace_members: {
        rows: 2,
        columns: ['id', 'joined_at', 'role', 'user_id', 'workspace_id'],
      },
      channels: {
        rows: 1,
        columns: [
          'created_at',
          'created_by',
          'deleted_at',
          'dm_key',
          'id',
          'last_message_at',
          'min_retention_days',
          'name',
          'only_admins_post',
          'retain_forever',
          'topic',
          'type',
          'updated_at',
          'workspace_id',
        ],
      },
      channel_members: {
        rows: 2,
        columns: ['channel_id', 'id', 'joined_at', 'user_id'],
      },
      messages: {
        rows: 1,
        columns: [
          'accepted_answer_id',
          'channel_id',
          'content',
          'created_at',
          'decision_note',
          'decision_updated_by',
          'decision_url',
          'deleted_at',
          'edited_at',
          'id',
          'is_question',
          'message_type',
          'metadata',
          'parent_id',
          'question_assignee_id',
          'resolved_at',
          'resolved_by',
          'sender_id',
          'thread_last_reply_at',
          'thread_reply_count',
          'updated_at',
          'workspace_id',
        ],
      },
      reactions: {
        rows: 1,
        columns: ['created_at', 'emoji', 'id', 'message_id', 'user_id'],
      },
      mentions: {
        rows: 1,
        columns: [
          'channel_id',
          'created_at',
          'id',
          'mentioned_user_id',
          'message_id',
          'workspace_id',
        ],
      },
      message_versions: {
        rows: 1,
        columns: ['channel_id', 'content', 'id', 'message_id', 'replaced_at', 'workspace_id'],
      },
      pinned_messages: {
        rows: 1,
        columns: ['channel_id', 'message_id', 'pinned_at', 'pinned_by', 'workspace_id'],
      },
      channel_bookmarks: {
        rows: 1,
        columns: ['added_at', 'added_by', 'channel_id', 'id', 'title', 'url', 'workspace_id'],
      },
      attachments: {
        rows: 1,
        columns: [
          'channel_id',
          'created_at',
          'file_name',
          'height',
          'id',
          'kind',
          'message_id',
          'mime_type',
          'size_bytes',
          'uploader_id',
          'width',
          'workspace_id',
        ],
      },
      incidents: {
        rows: 1,
        columns: [
          'channel_id',
          'declared_at',
          'declared_by',
          'id',
          'postmortem',
          'postmortem_version',
          'resolved_at',
          'runbook_url',
          'severity',
          'status',
          'workspace_id',
        ],
      },
      incident_updates: {
        rows: 1,
        columns: ['actor_id', 'at', 'from_value', 'id', 'incident_id', 'kind', 'to_value'],
      },
      incident_responders: {
        rows: 1,
        columns: ['added_at', 'added_by', 'channel_id', 'incident_id', 'user_id'],
      },
      github_repo_feeds: {
        rows: 1,
        columns: [
          'channel_id',
          'created_at',
          'created_by',
          'events',
          'id',
          'last_delivery_at',
          'last_failure',
          'last_failure_at',
          'repository_full_name',
          'repository_id',
          'workspace_id',
        ],
      },
      github_links: {
        rows: 1,
        columns: [
          'channel_id',
          'created_at',
          'created_by',
          'id',
          'kind',
          'number',
          'origin',
          'repository_full_name',
          'repository_id',
          'root_id',
          'state',
          'state_at',
          'title',
          'workspace_id',
        ],
      },
      workspace_invitations: {
        rows: 1,
        columns: ['created_at', 'created_by', 'expires_at', 'id', 'revoked_at', 'workspace_id'],
      },
      audit_log: {
        rows: 2,
        columns: [
          'action',
          'actor_user_id',
          'created_at',
          'id',
          'metadata',
          'target_id',
          'target_type',
          'workspace_id',
        ],
      },
    },
  },
};
