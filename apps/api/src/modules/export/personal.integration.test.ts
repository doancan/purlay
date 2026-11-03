/**
 * A person's export of their own data against the real database (D-241). pat is in two workspaces, wrote
 * in both, wrote in a private channel and then left it, deleted one message, reacted, saved, followed,
 * searched and kept a link, and sent a file; ann, beside pat, did each of those things too, and qui is in
 * the other workspace; a third workspace pat never touched has words of its own. The export holds exactly
 * pat's rows — counted against the database — every channel and workspace they name and no other, not one
 * word, name or address of anybody else's, not the deleted message, and none of pat's secrets. The
 * classification is bound to the catalogue: a table or a column nobody decided on fails here.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeIntegrationDatabase,
  sql,
  withRollback,
  type Database,
  type Transaction,
} from '@purlay/db';
import { PersonalExportManifest, messageId } from '@purlay/types';
import { Value } from '@sinclair/typebox/value';
import { fixedClock } from '../../platform/clock';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { atomicallyOn } from '../../platform/transactions';
import { aRecordingLogger } from '../../testing/doubles';
import { aRoom, type Room } from '../../testing/rooms';
import { aSession } from '../../testing/signed-in';
import { aMemoryStore, type MemoryStore } from '../../testing/storage';
import { storeUpload } from '../attachments/uploads';
import { sendMessage } from '../../features/chat/messages/messages';
import { exportPerson } from './personal';
import { MIGRATOR_TABLES } from './tables';
import {
  EVERY_TABLE_DECIDED_FOR_PEOPLE,
  EXCLUDED_FROM_PERSONAL_EXPORT,
  personalExportCatalogue,
} from '../../export-catalogue';
import { linkFile } from '../../testing/sent-files';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const NOW = new Date('2026-10-14T12:00:00.000Z');
const clock = fixedClock(NOW);
let tick = 0;
const next = (): Date => new Date(NOW.getTime() + (tick += 1));

type Member = NonNullable<Room['members'][string]>;
const member = (room: Room, name: string): Member => {
  const found = room.members[name];
  if (found === undefined) throw new Error(`no member ${name}`);
  return found;
};

/** One person's whole footprint in a room: what they wrote, reacted, saved, followed and sent. */
const footprint = async (
  db: Transaction,
  store: MemoryStore,
  room: Room,
  who: Member,
  words: string,
  other: string,
): Promise<{ message: string; file: string }> => {
  const where = { workspace_id: room.workspaceId, channel_id: room.channelId };
  const sent = await sendMessage(db, fixedClock(next()), who.context, {
    id: messageId(next()),
    content: words,
  });
  const message = sent.message.id;
  await db
    .insertInto('reactions')
    .values({ message_id: other, user_id: who.userId, emoji: '🎉' })
    .execute();
  await db
    .insertInto('saved_messages')
    .values({ id: messageId(next()), ...where, message_id: other, user_id: who.userId })
    .execute();
  await db
    .insertInto('thread_follows')
    .values({ ...where, message_id: other, user_id: who.userId, following: true })
    .execute();
  await db
    .insertInto('saved_searches')
    .values({
      id: messageId(next()),
      workspace_id: room.workspaceId,
      user_id: who.userId,
      name: `${words} search`,
      query: JSON.stringify({ text: words }),
    })
    .execute();
  await db
    .insertInto('channel_bookmarks')
    .values({
      id: messageId(next()),
      ...where,
      url: `https://docs.example.com/${who.username}`,
      title: `${words} link`,
      added_by: who.userId,
    })
    .execute();
  // Stored as an upload is, so its key is the one production writes.
  const file = messageId(next());
  await storeUpload(
    { atomically: atomicallyOn(db), storage: store, log: aRecordingLogger().log },
    await requireWorkspaceMembership(db, who.userId, room.workspaceId),
    { id: file, name: `${who.username}.txt`, bytes: new TextEncoder().encode(words) },
  );
  await db
    .updateTable('attachments')
    .set({ message_id: message, channel_id: room.channelId })
    .where('id', '=', file)
    .execute();
  await linkFile(db, {
    id: file,
    workspaceId: room.workspaceId,
    messageId: message,
    channelId: room.channelId,
  });
  return { message, file };
};

const lines = async (directory: string, table: string): Promise<Record<string, unknown>[]> =>
  (await readFile(join(directory, `${table}.ndjson`), 'utf8'))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

/** The fixture: pat in two workspaces with a footprint in each, beside others who did the same. */
interface Fixture {
  store: MemoryStore;
  a: Room;
  b: Room;
  c: Room;
  pat: Member;
  ann: Member;
  qui: Member;
  patA: { message: string; file: string };
  patB: { message: string; file: string };
  annOwn: { message: string; file: string };
  quiOwn: { message: string; file: string };
  left: { id: string };
  before: { message: { id: string } };
  regretted: { message: { id: string } };
  passwordHash: string;
  totpSecret: string;
  token: string;
  tokenHash: string;
}

const aPersonWithAFootprint = async (db: Transaction): Promise<Fixture> => {
  const store = aMemoryStore();
  const a = await aRoom(db, ['pat', 'ann']);
  const b = await aRoom(db, ['qui', 'pat2']);
  const c = await aRoom(db, ['zed']);
  // pat is in both: b's second member becomes pat.
  const pat = member(a, 'pat');
  const ann = member(a, 'ann');
  const qui = member(b, 'qui');
  for (const table of ['workspace_members', 'channel_members'] as const) {
    await db
      .updateTable(table)
      .set({ user_id: pat.userId })
      .where('user_id', '=', member(b, 'pat2').userId)
      .execute();
  }
  const patInB: Member = {
    ...pat,
    context: { ...member(b, 'pat2').context, userId: pat.userId },
  };
  await db
    .updateTable('channel_members')
    .set({ notification_level: 'mentions', starred_at: NOW })
    .where('user_id', '=', pat.userId)
    .where('channel_id', '=', a.channelId)
    .execute();

  // Others write first, so each footprint has someone else's message to react to and save.
  const annFirst = await sendMessage(db, fixedClock(next()), ann.context, {
    id: messageId(next()),
    content: 'ann wrote this first',
  });
  const quiFirst = await sendMessage(db, fixedClock(next()), qui.context, {
    id: messageId(next()),
    content: 'qui wrote this first',
  });
  await sendMessage(db, fixedClock(next()), member(c, 'zed').context, {
    id: messageId(next()),
    content: 'zed alone in c',
  });
  const patA = await footprint(db, store, a, pat, 'pat in acme', annFirst.message.id);
  const patB = await footprint(db, store, b, patInB, 'pat in beta', quiFirst.message.id);
  const annOwn = await footprint(db, store, a, ann, 'ann in acme', patA.message);
  const quiOwn = await footprint(db, store, b, qui, 'qui in beta', patB.message);

  // A private channel pat wrote in, then left: what they wrote there is still theirs.
  const left = await db
    .insertInto('channels')
    .values({
      workspace_id: a.workspaceId,
      name: 'gone-from',
      type: 'private',
      created_by: ann.userId,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('channel_members')
    .values({ channel_id: left.id, user_id: pat.userId, joined_at: NOW })
    .execute();
  const before = await sendMessage(
    db,
    fixedClock(next()),
    { ...pat.context, channelId: left.id },
    { id: messageId(next()), content: 'said before leaving' },
  );
  await db
    .deleteFrom('channel_members')
    .where('channel_id', '=', left.id)
    .where('user_id', '=', pat.userId)
    .execute();
  // A message pat deleted: its words are not offered back.
  const regretted = await sendMessage(db, fixedClock(next()), pat.context, {
    id: messageId(next()),
    content: 'regretted words',
  });
  await db
    .updateTable('messages')
    .set({ deleted_at: NOW })
    .where('id', '=', regretted.message.id)
    .execute();

  // pat's secrets, each in its own table: none may ride out.
  const passwordHash = `scrypt:${crypto.randomUUID()}`;
  await db
    .insertInto('accounts')
    .values({
      account_id: pat.userId,
      provider_id: 'credential',
      user_id: pat.userId,
      password: passwordHash,
    })
    .execute();
  const totpSecret = `sealed-${crypto.randomUUID()}`;
  await db
    .insertInto('two_factors')
    .values({ user_id: pat.userId, secret: totpSecret, backup_codes: `codes-${totpSecret}` })
    .execute();
  const { token } = await aSession(db, clock, pat.userId);
  const tokenHash = (
    await db
      .selectFrom('sessions')
      .select('token_hash')
      .where('user_id', '=', pat.userId)
      .executeTakeFirstOrThrow()
  ).token_hash;
  return {
    store,
    a,
    b,
    c,
    pat,
    ann,
    qui,
    patA,
    patB,
    annOwn,
    quiOwn,
    left,
    before,
    regretted,
    passwordHash,
    totpSecret,
    token,
    tokenHash,
  };
};

describe('integration: exporting a person’s own data', () => {
  test('holds exactly their rows, the places they name, and nothing of anybody else’s', async () => {
    await withRollback(async (db) => {
      const {
        store,
        a,
        b,
        c,
        pat,
        ann,
        qui,
        patA,
        patB,
        annOwn,
        quiOwn,
        left,
        before,
        regretted,
        passwordHash,
        totpSecret,
        token,
        tokenHash,
      } = await aPersonWithAFootprint(db);

      const target = join(await mkdtemp(join(tmpdir(), 'purlay-personal-')), 'out');
      const { path, manifest } = await exportPerson(
        {
          database: db,
          clock,
          log: aRecordingLogger().log,
          storage: store,
          personalCatalogue: personalExportCatalogue,
        },
        { id: pat.userId, username: pat.username },
        target,
      );
      expect(path).toBe(target);
      expect(Value.Check(PersonalExportManifest, manifest)).toBe(true);
      expect(JSON.parse(await readFile(join(target, 'manifest.json'), 'utf8'))).toEqual(manifest);
      expect((await readdir(target)).sort()).toEqual(
        [
          ...personalExportCatalogue.order.map((table) => `${table}.ndjson`),
          'blobs',
          'manifest.json',
        ].sort(),
      );

      // Every table written, its count its file's, none empty, each row pat's and only the columns decided.
      for (const table of personalExportCatalogue.order) {
        const rows = await lines(target, table);
        expect({ table, rows: rows.length }).toEqual({ table, rows: manifest.tables[table] ?? -1 });
        expect({ table, empty: rows.length === 0 }).toEqual({ table, empty: false });
        const decided = Object.entries(personalExportCatalogue.table(table).columns)
          .filter(([, kind]) => kind === 'export')
          .map(([column]) => column)
          .sort();
        for (const row of rows) {
          expect({ table, columns: Object.keys(row).sort() }).toEqual({ table, columns: decided });
          for (const column of ['user_id', 'sender_id', 'added_by', 'uploader_id']) {
            if (column in row)
              expect({ table, [column]: row[column] }).toEqual({ table, [column]: pat.userId });
          }
        }
      }

      // The messages are exactly those the database says pat wrote and did not delete.
      const written = await db
        .selectFrom('messages')
        .select('id')
        .where('sender_id', '=', pat.userId)
        .where('deleted_at', 'is', null)
        .orderBy('id')
        .execute();
      expect((await lines(target, 'messages')).map((row) => row['id'])).toEqual(
        written.map((row) => row.id),
      );
      expect(written.map((row) => row.id)).toContain(before.message.id);
      expect(written).toHaveLength(3);

      // Every place a row names is there, and no other.
      const channels = new Set((await lines(target, 'channels')).map((row) => row['id']));
      const workspaces = new Set((await lines(target, 'workspaces')).map((row) => row['id']));
      for (const table of personalExportCatalogue.order) {
        for (const row of await lines(target, table)) {
          if (typeof row['channel_id'] === 'string')
            expect(channels.has(row['channel_id'])).toBe(true);
          if (typeof row['workspace_id'] === 'string')
            expect(workspaces.has(row['workspace_id'])).toBe(true);
        }
      }
      expect([...channels].sort()).toEqual([a.channelId, b.channelId, left.id].sort());
      expect([...workspaces].sort()).toEqual([a.workspaceId, b.workspaceId].sort());

      // pat alone, with the address; nobody else's anything, and no secret of pat's.
      const people = await lines(target, 'users');
      expect(people).toHaveLength(1);
      expect(people[0]).toMatchObject({ id: pat.userId, username: pat.username });
      expect(String(people[0]?.['email'])).toContain('@');
      let everything = '';
      for (const file of await readdir(target)) {
        if (file !== 'blobs') everything += await readFile(join(target, file), 'utf8');
      }
      for (const blob of await readdir(join(target, 'blobs'))) {
        everything += await readFile(join(target, 'blobs', blob), 'utf8');
      }
      for (const absent of [
        'ann wrote this first',
        'qui wrote this first',
        'zed alone in c',
        'ann in acme',
        'qui in beta',
        'regretted words',
        regretted.message.id,
        ann.userId,
        ann.username,
        qui.userId,
        qui.username,
        annOwn.message,
        annOwn.file,
        quiOwn.file,
        c.workspaceId,
        c.channelId,
        passwordHash,
        totpSecret,
        token,
        tokenHash,
      ]) {
        expect({ absent, found: everything.includes(absent) }).toEqual({ absent, found: false });
      }
      for (const present of ['pat in acme', 'pat in beta', 'said before leaving', 'mentions']) {
        expect(everything).toContain(present);
      }

      // pat's files, byte for byte, owner-only; nobody else's.
      expect(manifest.blobs).toMatchObject({ count: 2, removed: [], missing: [] });
      expect((await readdir(join(target, 'blobs'))).sort()).toEqual([patA.file, patB.file].sort());
      expect(await readFile(join(target, 'blobs', patA.file), 'utf8')).toBe('pat in acme');
      expect((await stat(target)).mode & 0o777).toBe(0o700);
      expect((await stat(join(target, 'messages.ndjson'))).mode & 0o777).toBe(0o600);
    });
  });

  test('a person who wrote nothing: every file there, empty, and their own row', async () => {
    await withRollback(async (db) => {
      const room = await aRoom(db, ['new']);
      const person = member(room, 'new');
      const target = join(await mkdtemp(join(tmpdir(), 'purlay-personal-')), 'out');
      const { manifest } = await exportPerson(
        {
          database: db,
          clock,
          log: aRecordingLogger().log,
          storage: aMemoryStore(),
          personalCatalogue: personalExportCatalogue,
        },
        { id: person.userId, username: person.username },
        target,
      );
      expect(manifest.tables).toMatchObject({ users: 1, messages: 0, attachments: 0 });
      expect(await lines(target, 'messages')).toEqual([]);
      expect(manifest.blobs).toEqual({ count: 0, bytes: 0, removed: [], missing: [] });
    });
  });

  test('every table and every column of the catalogue is decided on', async () => {
    // The compile-time half: the composition root does not compile while a table of the schema is undecided.
    expect(EVERY_TABLE_DECIDED_FOR_PEOPLE).toBe(true);
    await withRollback(async (db) => {
      const { rows } = await sql<{ table: string; columns: string[] }>`
        select table_name as table, array_agg(column_name::text order by column_name) as columns
        from information_schema.columns where table_schema = 'public'
        group by table_name
      `.execute(db);
      const decided = [
        ...personalExportCatalogue.order,
        ...Object.keys(EXCLUDED_FROM_PERSONAL_EXPORT),
      ];
      expect(
        rows
          .map((row) => row.table)
          .filter((table) => !MIGRATOR_TABLES.includes(table))
          .sort(),
      ).toEqual([...decided].sort());
      for (const row of rows) {
        if (!personalExportCatalogue.order.some((name) => name === row.table)) continue;
        expect({ table: row.table, columns: row.columns }).toEqual({
          table: row.table,
          columns: Object.keys(
            personalExportCatalogue.table(row.table as keyof Database).columns,
          ).sort(),
        });
      }
    });
  });
});

/**
 * The shape of what a person's export writes, held still so that moving its catalogue between modules (D-250)
 * cannot change a file unseen: the tables in the order the manifest lists them, which is the order they are
 * written in, and for each how many rows the fixture gives it and the columns of those rows. The values are
 * random or time-bound; the shape is not.
 */
const shapeOf = async (
  directory: string,
  tables: Readonly<Record<string, number>>,
): Promise<Record<string, unknown>> => {
  const shape: Record<string, unknown> = {};
  for (const table of Object.keys(tables)) {
    const rows = await lines(directory, table);
    shape[table] = { rows: rows.length, columns: Object.keys(rows[0] ?? {}).sort() };
  }
  return { order: Object.keys(tables), files: (await readdir(directory)).sort(), tables: shape };
};

describe('integration: the shape of a person’s export', () => {
  test('is the one it has always written', async () => {
    await withRollback(async (db) => {
      const { store, pat } = await aPersonWithAFootprint(db);
      const target = join(await mkdtemp(join(tmpdir(), 'purlay-personal-shape-')), 'out');
      const { manifest } = await exportPerson(
        {
          database: db,
          clock,
          log: aRecordingLogger().log,
          storage: store,
          personalCatalogue: personalExportCatalogue,
        },
        { id: pat.userId, username: pat.username },
        target,
      );
      expect(await shapeOf(target, manifest.tables)).toEqual(FROZEN_SHAPE);
    });
  });
});

describe('integration: a person’s export that fails', () => {
  test('is no export, and leaves nothing named as one: the directory is abandoned and the error is the store’s', async () => {
    await withRollback(async (db) => {
      const { store, pat } = await aPersonWithAFootprint(db);
      const target = join(await mkdtemp(join(tmpdir(), 'purlay-personal-failed-')), 'out');
      const error = new Error('the store is down');
      store.failing('get', error);
      const result = await exportPerson(
        {
          database: db,
          clock,
          log: aRecordingLogger().log,
          storage: store,
          personalCatalogue: personalExportCatalogue,
        },
        { id: pat.userId, username: pat.username },
        target,
      ).then(
        () => null,
        (failure: unknown) => failure,
      );
      expect(result).toBe(error);
      expect(
        await stat(target).then(
          () => 'there',
          () => 'absent',
        ),
      ).toBe('absent');
    });
  });
});

/**
 * As written when this test was made, before the catalogue moved between modules. A change that is meant says so
 * by changing this, in the same pull request, with the reason. (`google_made` is the Google sign-in change's: a column of
 * `users` it added to a person's own export after this was first frozen.)
 */
const FROZEN_SHAPE: Record<string, unknown> = {
  order: [
    'users',
    'workspaces',
    'workspace_members',
    'channels',
    'channel_members',
    'messages',
    'reactions',
    'attachments',
    'saved_messages',
    'saved_searches',
    'thread_follows',
    'channel_bookmarks',
  ],
  files: [
    'attachments.ndjson',
    'blobs',
    'channel_bookmarks.ndjson',
    'channel_members.ndjson',
    'channels.ndjson',
    'manifest.json',
    'messages.ndjson',
    'reactions.ndjson',
    'saved_messages.ndjson',
    'saved_searches.ndjson',
    'thread_follows.ndjson',
    'users.ndjson',
    'workspace_members.ndjson',
    'workspaces.ndjson',
  ],
  tables: {
    users: {
      rows: 1,
      columns: [
        'avatar_url',
        'created_at',
        'deleted_at',
        'display_name',
        'email',
        'email_verified',
        'github_connected_at',
        'github_id',
        'github_login',
        'google_made',
        'id',
        'is_server_admin',
        'last_seen_at',
        'locale',
        'missed_mail_since',
        'quiet_days',
        'quiet_from',
        'quiet_to',
        'status_text',
        'suspended_at',
        'time_zone',
        'title',
        'two_factor_enabled',
        'updated_at',
        'username',
      ],
    },
    workspaces: {
      rows: 2,
      columns: ['id', 'name', 'slug'],
    },
    workspace_members: {
      rows: 2,
      columns: [
        'deep_work_until',
        'id',
        'is_deep_work_active',
        'joined_at',
        'role',
        'user_id',
        'workspace_id',
      ],
    },
    channels: {
      rows: 3,
      columns: ['id', 'name', 'type', 'workspace_id'],
    },
    channel_members: {
      rows: 2,
      columns: [
        'channel_id',
        'id',
        'joined_at',
        'last_read_message_id',
        'notification_level',
        'starred_at',
        'user_id',
      ],
    },
    messages: {
      rows: 3,
      columns: [
        'channel_id',
        'content',
        'created_at',
        'edited_at',
        'id',
        'is_question',
        'message_type',
        'metadata',
        'parent_id',
        'sender_id',
        'updated_at',
        'workspace_id',
      ],
    },
    reactions: {
      rows: 2,
      columns: ['created_at', 'emoji', 'id', 'message_id', 'user_id'],
    },
    attachments: {
      rows: 2,
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
    saved_messages: {
      rows: 2,
      columns: [
        'channel_id',
        'id',
        'message_id',
        'saved_at',
        'state',
        'updated_at',
        'user_id',
        'workspace_id',
      ],
    },
    saved_searches: {
      rows: 2,
      columns: ['created_at', 'id', 'name', 'query', 'user_id', 'workspace_id'],
    },
    thread_follows: {
      rows: 2,
      columns: ['channel_id', 'following', 'message_id', 'updated_at', 'user_id', 'workspace_id'],
    },
    channel_bookmarks: {
      rows: 2,
      columns: ['added_at', 'added_by', 'channel_id', 'id', 'title', 'url', 'workspace_id'],
    },
  },
};
