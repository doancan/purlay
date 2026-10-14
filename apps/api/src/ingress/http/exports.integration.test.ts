/**
 * An owner's export over HTTP (D-140 §1), on a cloned database — the export is made by the process in
 * the background, on connections of its own, which the harness's one transaction cannot give (D-46).
 *
 * Made by the process's own queue and downloaded once as an archive `tar` opens: the channels the owner
 * can see — the public ones and the private one they are in, not the private one they are not in — and
 * nobody's address. The asker's alone: another owner neither lists nor downloads it. A second download,
 * one after expiry, one the store cuts off: none serves it twice, and the archive leaves the store each
 * time. One at a time; an owner demoted before it starts; a store that refuses; a long address with a
 * file in it. And the sweep.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloneIntegrationDatabase, type ClonedDatabase } from '@purlay/db';
import { messageId, type WorkspaceExport } from '@purlay/types';
import { HOUR_MS, fixedClock } from '../../platform/clock';
import { SESSION_COOKIE } from '../../platform/cookies';
import { createLogger } from '../../platform/logging';
import {
  NOW,
  aDatabaseThatMustNotBeTouched,
  aMovableClock,
  aRecordingLogger,
  testDependencies,
} from '../../testing/doubles';
import { aRoom, type Room } from '../../testing/rooms';
import { aMemoryStore, type MemoryStore } from '../../testing/storage';
import { issueSession } from '../../modules/auth/sessions';
import { sendMessage } from '../../modules/messages/messages';
import { exportQueue, sayAlive, sweepExports } from '../../modules/export/requests';
import { createApp } from './app';

let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
});

afterAll(async () => {
  await cloned.drop();
});

const ORIGIN = 'https://purlay.test';
const clock = fixedClock(NOW);
const silent = createLogger({ level: 'silent' });

type Caller = (method: 'GET' | 'POST', path: string) => Promise<Response>;

interface World {
  readonly room: Room;
  readonly store: MemoryStore;
  /** A signed-in caller, by name. */
  readonly as: (name: string) => Promise<Caller>;
  /** Every export started so far has finished. */
  readonly settled: () => Promise<void>;
  readonly exports: string;
}

/**
 * ada and bob own a workspace; the process's own queue makes its exports, as production has it. With
 * `held`, an asked export is not started until the test starts it.
 */
const aWorld = async (
  store = aMemoryStore(),
  held?: (start: (id: string) => void, id: string) => void,
): Promise<World> => {
  const room = await aRoom(cloned.db, ['ada', 'bob']);
  await cloned.db
    .updateTable('workspace_members')
    .set({ role: 'owner' })
    .where('workspace_id', '=', room.workspaceId)
    .where('user_id', '=', room.members['bob']?.userId ?? '')
    .execute();
  const queue = exportQueue({ database: cloned.db, clock, log: silent, storage: store });
  const app = createApp(
    testDependencies({
      database: cloned.db,
      clock,
      storage: store,
      exportRunner: (id): void => {
        if (held === undefined) queue.start(id);
        else held(queue.start, id);
      },
    }),
  );
  return {
    room,
    store,
    settled: queue.settled,
    exports: `/api/workspaces/${room.workspaceId}/exports`,
    as: async (name): Promise<Caller> => {
      const person = room.members[name];
      if (person === undefined) throw new Error(`no ${name}`);
      const { token } = await issueSession(cloned.db, clock, person.userId, 30);
      return async (method, path): Promise<Response> =>
        await app.handle(
          new Request(`${ORIGIN}${path}`, {
            method,
            headers: { cookie: `${SESSION_COOKIE}=${token}`, origin: ORIGIN },
          }),
        );
    },
  };
};

const codeOf = async (response: Response): Promise<[number, string]> => [
  response.status,
  ((await response.json()) as { error: { code: string } }).error.code,
];

const listOf = async (caller: Caller, world: World): Promise<WorkspaceExport[]> =>
  (await (await caller('GET', world.exports)).json()) as WorkspaceExport[];

/** Asks for an export as this caller and waits until the queue has made it. */
const made = async (caller: Caller, world: World): Promise<WorkspaceExport> => {
  const asked = await caller('POST', world.exports);
  expect(asked.status).toBe(202);
  const { id } = (await asked.json()) as WorkspaceExport;
  await world.settled();
  const found = (await listOf(caller, world)).find((each) => each.id === id);
  if (found === undefined) throw new Error('the export is not listed');
  return found;
};

describe('integration: an owner’s export', () => {
  test('made, downloaded once: what the owner can see, nobody’s address, theirs alone', async () => {
    const world = await aWorld();
    const { room } = world;
    const ada = room.members['ada'];
    const bob = room.members['bob'];
    if (ada === undefined || bob === undefined) throw new Error('no people');
    await sendMessage(cloned.db, clock, ada.context, {
      id: messageId(NOW),
      content: 'public words',
    });
    const privateChannel = async (name: string): Promise<string> =>
      (
        await cloned.db
          .insertInto('channels')
          .values({ workspace_id: room.workspaceId, name, type: 'private', created_by: bob.userId })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    const hers = await privateChannel('ada-and-bob');
    const bobs = await privateChannel('bob-alone');
    await cloned.db
      .insertInto('channel_members')
      .values({ channel_id: hers, user_id: ada.userId })
      .execute();

    const ask = await world.as('ada');
    const ready = await made(ask, world);
    expect(ready).toMatchObject({ status: 'ready', failure: null });
    expect(ready.expiresAt).toBe(new Date(NOW.getTime() + 24 * HOUR_MS).toISOString());

    // Another owner: it holds what ada can see, so it is not theirs to list or to take.
    const other = await world.as('bob');
    expect(await listOf(other, world)).toEqual([]);
    const path = `${world.exports}/${ready.id}/download`;
    expect(await codeOf(await other('GET', path))).toEqual([404, 'EXPORT_NOT_FOUND']);

    const download = await ask('GET', path);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('application/x-tar');
    expect(download.headers.get('content-disposition')).toContain('attachment; filename=');
    // Every response's own headers, kept on a Response the handler made itself.
    expect(download.headers.get('x-request-id')).not.toBeNull();
    expect(download.headers.get('content-security-policy')).not.toBeNull();
    expect(download.headers.get('cache-control')).toBe('no-store');
    const bytes = new Uint8Array(await download.arrayBuffer());
    expect(bytes.length).toBe(ready.sizeBytes ?? -1);

    const scratch = await mkdtemp(join(tmpdir(), 'purlay-export-test-'));
    await writeFile(join(scratch, 'export.tar'), bytes);
    expect(Bun.spawnSync(['tar', '-xf', join(scratch, 'export.tar'), '-C', scratch]).exitCode).toBe(
      0,
    );
    const table = async (name: string): Promise<string> =>
      await readFile(join(scratch, 'export', `${name}.ndjson`), 'utf8');
    expect(await table('messages')).toContain('public words');
    const channels = await table('channels');
    expect(channels).toContain(room.channelId);
    expect(channels).toContain(hers);
    expect(channels).not.toContain(bobs);
    const users = (await table('users'))
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { email: unknown });
    expect(users.length).toBeGreaterThan(0);
    expect(users.every((person) => person.email === null)).toBe(true);

    // Once: the second is not found, the archive left the store, and the list says downloaded.
    expect(await codeOf(await ask('GET', path))).toEqual([404, 'EXPORT_NOT_FOUND']);
    expect(world.store.keys()).toEqual([]);
    expect((await listOf(ask, world)).find((each) => each.id === ready.id)?.status).toBe(
      'downloaded',
    );
    // On the trail, by the owner who asked.
    expect(
      await cloned.db
        .selectFrom('audit_log')
        .select(['action', 'actor_user_id'])
        .where('workspace_id', '=', room.workspaceId)
        .where('action', 'in', ['workspace.export_requested', 'workspace.exported'])
        .orderBy('action')
        .execute(),
    ).toEqual([
      { action: 'workspace.export_requested', actor_user_id: ada.userId },
      { action: 'workspace.exported', actor_user_id: ada.userId },
    ]);
  });

  test('another workspace’s export, asked through the owner’s own workspace: not found', async () => {
    const theirs = await aWorld();
    const foreign = await made(await theirs.as('ada'), theirs);
    const mine = await aWorld();
    const ask = await mine.as('ada');
    expect(await codeOf(await ask('GET', `${mine.exports}/${foreign.id}/download`))).toEqual([
      404,
      'EXPORT_NOT_FOUND',
    ]);
    expect(theirs.store.keys()).toHaveLength(1);
  });

  test('a download the store cuts off is spent, and its archive still leaves the store', async () => {
    const world = await aWorld();
    const ask = await world.as('ada');
    const ready = await made(ask, world);
    world.store.failing('stream', new Error('connection reset'));
    const path = `${world.exports}/${ready.id}/download`;
    const cut = await ask('GET', path);
    // However the runtime ends a body that errored — rejected, or short — it is not the whole archive.
    const got = await cut.arrayBuffer().then(
      (bytes) => bytes.byteLength,
      () => 0,
    );
    expect(got).toBeLessThan(ready.sizeBytes ?? 0);
    expect(world.store.keys()).toEqual([]);
    expect(await codeOf(await ask('GET', path))).toEqual([404, 'EXPORT_NOT_FOUND']);
  });

  test('a download whose archive cannot be read is spent, and the archive still goes', async () => {
    const world = await aWorld();
    const ask = await world.as('ada');
    const ready = await made(ask, world);
    world.store.failing('get', new Error('the bucket is unreachable'));
    const path = `${world.exports}/${ready.id}/download`;
    expect((await ask('GET', path)).status).toBe(500);
    expect(world.store.keys()).toEqual([]);
    expect(await codeOf(await ask('GET', path))).toEqual([404, 'EXPORT_NOT_FOUND']);
  });

  test('a download whose archive the store will not let go of is still spent', async () => {
    const world = await aWorld();
    const ask = await world.as('ada');
    const ready = await made(ask, world);
    world.store.failing('delete', new Error('the bucket refuses'));
    const path = `${world.exports}/${ready.id}/download`;
    const first = await ask('GET', path);
    expect((await first.arrayBuffer()).byteLength).toBe(ready.sizeBytes ?? -1);
    // The row still names the archive, for the sweep; the link does not serve it again.
    expect(world.store.keys()).toHaveLength(1);
    expect(await codeOf(await ask('GET', path))).toEqual([404, 'EXPORT_NOT_FOUND']);
  });

  test('one at a time: while one is being made, another is refused', async () => {
    const world = await aWorld(aMemoryStore(), () => undefined);
    const ask = await world.as('ada');
    expect((await ask('POST', world.exports)).status).toBe(202);
    expect(await codeOf(await ask('POST', world.exports))).toEqual([409, 'EXPORT_IN_PROGRESS']);
    // Nor by the other owner: one per workspace, not one per person.
    expect(await codeOf(await (await world.as('bob'))('POST', world.exports))).toEqual([
      409,
      'EXPORT_IN_PROGRESS',
    ]);
  });

  test('an owner demoted before it starts is not exported for', async () => {
    const waiting: string[] = [];
    let begin: ((id: string) => void) | undefined;
    const world = await aWorld(aMemoryStore(), (start, id) => {
      begin = start;
      waiting.push(id);
    });
    const ask = await world.as('ada');
    expect((await ask('POST', world.exports)).status).toBe(202);
    await cloned.db
      .updateTable('workspace_members')
      .set({ role: 'member' })
      .where('workspace_id', '=', world.room.workspaceId)
      .where('user_id', '=', world.room.members['ada']?.userId ?? '')
      .execute();
    for (const id of waiting) begin?.(id);
    await world.settled();
    expect(
      await cloned.db
        .selectFrom('workspace_exports')
        .select(['status', 'failure', 'storage_key'])
        .where('workspace_id', '=', world.room.workspaceId)
        .execute(),
    ).toEqual([{ status: 'failed', failure: 'EXPORT_REQUESTER_GONE', storage_key: null }]);
    expect(world.store.keys()).toEqual([]);
  });

  test('an owner removed from the workspace before it starts is not exported for', async () => {
    const waiting: string[] = [];
    let begin: ((id: string) => void) | undefined;
    const world = await aWorld(aMemoryStore(), (start, id) => {
      begin = start;
      waiting.push(id);
    });
    expect((await (await world.as('ada'))('POST', world.exports)).status).toBe(202);
    await cloned.db
      .deleteFrom('workspace_members')
      .where('workspace_id', '=', world.room.workspaceId)
      .where('user_id', '=', world.room.members['ada']?.userId ?? '')
      .execute();
    for (const id of waiting) begin?.(id);
    await world.settled();
    expect(
      await cloned.db
        .selectFrom('workspace_exports')
        .select(['status', 'failure'])
        .where('workspace_id', '=', world.room.workspaceId)
        .execute(),
    ).toEqual([{ status: 'failed', failure: 'EXPORT_REQUESTER_GONE' }]);
  });

  for (const refusesDelete of [false, true]) {
    test(`stored, then not recorded as ready: failed, and the archive ${refusesDelete ? 'it cannot remove is logged' : 'goes'}`, async () => {
      const waiting: string[] = [];
      const world = await aWorld(aMemoryStore(), (_start, id) => {
        waiting.push(id);
      });
      expect((await (await world.as('ada'))('POST', world.exports)).status).toBe(202);
      // The next instant asked for, once the archive is stored, cannot be had: the write it is for fails.
      let breakNext = false;
      const store: MemoryStore = {
        ...world.store,
        putFile: async (key, path, type): Promise<void> => {
          await world.store.putFile(key, path, type);
          breakNext = true;
        },
      };
      if (refusesDelete) world.store.failing('delete', new Error('the bucket refuses'));
      const { log, lines } = aRecordingLogger();
      const queue = exportQueue({
        database: cloned.db,
        clock: {
          now: (): Date => {
            if (!breakNext) return NOW;
            breakNext = false;
            throw new Error('the database went away');
          },
        },
        log,
        storage: store,
      });
      for (const id of waiting) queue.start(id);
      await queue.settled();
      expect(
        await cloned.db
          .selectFrom('workspace_exports')
          .select(['status', 'failure', 'storage_key'])
          .where('workspace_id', '=', world.room.workspaceId)
          .execute(),
      ).toEqual([{ status: 'failed', failure: 'EXPORT_FAILED', storage_key: null }]);
      expect(world.store.keys()).toHaveLength(refusesDelete ? 1 : 0);
      expect(
        lines
          .map((line) => line['msg'])
          .includes('a failed export’s archive could not be removed from storage'),
      ).toBe(refusesDelete);
    });
  }

  test('a store that refuses the archive: the export failed, said by a code', async () => {
    const store = aMemoryStore();
    store.failing('put', new Error('the bucket is gone'));
    const world = await aWorld(store);
    expect(await made(await world.as('ada'), world)).toMatchObject({
      status: 'failed',
      failure: 'EXPORT_FAILED',
    });
  });

  test('a workspace with a long address and a file in it is archived whole', async () => {
    const world = await aWorld();
    const { room } = world;
    const ada = room.members['ada'];
    if (ada === undefined) throw new Error('no ada');
    await cloned.db
      .updateTable('workspaces')
      .set({ slug: `a${'b'.repeat(46)}c` })
      .where('id', '=', room.workspaceId)
      .execute();
    const sent = messageId(new Date(NOW.getTime() + 5));
    await sendMessage(cloned.db, clock, ada.context, { id: sent, content: 'with a file' });
    const fileId = messageId(new Date(NOW.getTime() + 6));
    const storageKey = `${room.workspaceId}/${fileId}/plan.pdf`;
    await world.store.put(storageKey, new Uint8Array(10), 'application/pdf');
    await cloned.db
      .insertInto('attachments')
      .values({
        id: fileId,
        workspace_id: room.workspaceId,
        channel_id: room.channelId,
        message_id: sent,
        uploader_id: ada.userId,
        storage_key: storageKey,
        file_name: 'plan.pdf',
        mime_type: 'application/pdf',
        size_bytes: '10',
      })
      .execute();
    const ask = await world.as('ada');
    const ready = await made(ask, world);
    expect(ready.status).toBe('ready');
    const bytes = new Uint8Array(
      await (await ask('GET', `${world.exports}/${ready.id}/download`)).arrayBuffer(),
    );
    const scratch = await mkdtemp(join(tmpdir(), 'purlay-export-test-'));
    await writeFile(join(scratch, 'export.tar'), bytes);
    const listing = Bun.spawnSync(['tar', '-tf', join(scratch, 'export.tar')]);
    expect(listing.exitCode).toBe(0);
    expect(listing.stdout.toString()).toContain(`export/blobs/${fileId}`);
  });

  test('a download whose archive is already gone from the store is our failure, and spent', async () => {
    const world = await aWorld();
    const ask = await world.as('ada');
    const ready = await made(ask, world);
    for (const key of world.store.keys()) await world.store.delete(key);
    const path = `${world.exports}/${ready.id}/download`;
    expect(await codeOf(await ask('GET', path))).toEqual([500, 'INTERNAL']);
    expect(await codeOf(await ask('GET', path))).toEqual([404, 'EXPORT_NOT_FOUND']);
  });

  test('a download the browser walks away from is spent, and its archive leaves the store', async () => {
    const memory = aMemoryStore();
    // A store slower than the browser: one byte, then nothing until the reader goes away.
    let readsCancelled = 0;
    const store: MemoryStore = {
      ...memory,
      get: async (key) => {
        const stored = await memory.get(key);
        if (stored === null) return null;
        const body = new ReadableStream<Uint8Array>({
          start: (controller): void => {
            controller.enqueue(new Uint8Array([1]));
          },
          cancel: (): void => {
            readsCancelled += 1;
          },
        });
        return { body, size: stored.size };
      },
    };
    const world = await aWorld(store);
    const ask = await world.as('ada');
    const ready = await made(ask, world);
    const path = `${world.exports}/${ready.id}/download`;
    const body = (await ask('GET', path)).body;
    if (body === null) throw new Error('no body');
    const reader = body.getReader();
    expect((await reader.read()).value).toEqual(new Uint8Array([1]));
    await reader.cancel('the tab was closed');
    expect(readsCancelled).toBe(1);
    expect(memory.keys()).toEqual([]);
    expect(await codeOf(await ask('GET', path))).toEqual([404, 'EXPORT_NOT_FOUND']);
  });

  test('a workspace deleted before its export starts: failed, and nothing made', async () => {
    const waiting: string[] = [];
    let begin: ((id: string) => void) | undefined;
    const world = await aWorld(aMemoryStore(), (start, id) => {
      begin = start;
      waiting.push(id);
    });
    const ask = await world.as('ada');
    expect((await ask('POST', world.exports)).status).toBe(202);
    await cloned.db
      .updateTable('workspaces')
      .set({ deleted_at: NOW })
      .where('id', '=', world.room.workspaceId)
      .execute();
    for (const id of waiting) begin?.(id);
    await world.settled();
    expect(
      await cloned.db
        .selectFrom('workspace_exports')
        .select(['status', 'failure'])
        .where('workspace_id', '=', world.room.workspaceId)
        .execute(),
    ).toEqual([{ status: 'failed', failure: 'EXPORT_FAILED' }]);
    expect(world.store.keys()).toEqual([]);
  });

  test('a run given up on while it stored its archive: the archive is nobody’s, and goes', async () => {
    const memory = aMemoryStore();
    const store: MemoryStore = {
      ...memory,
      putFile: async (key, path, type): Promise<void> => {
        await memory.putFile(key, path, type);
        // The sweep, meanwhile, took it for cut off.
        await cloned.db
          .updateTable('workspace_exports')
          .set({ status: 'failed', failure: 'EXPORT_ABANDONED' })
          .where('status', '=', 'pending')
          .where('workspace_id', '=', key.split('/')[0] ?? '')
          .execute();
      },
    };
    const world = await aWorld(store);
    expect(await made(await world.as('ada'), world)).toMatchObject({
      status: 'failed',
      failure: 'EXPORT_ABANDONED',
    });
    expect(memory.keys()).toEqual([]);
  });

  test('a failure it cannot even record is logged, and the queue goes on', async () => {
    const { log, lines } = aRecordingLogger();
    const queue = exportQueue({
      database: aDatabaseThatMustNotBeTouched(new Error('the database is down')),
      clock,
      log,
      storage: aMemoryStore(),
    });
    queue.start(messageId(NOW));
    await queue.settled();
    expect(lines.map((line) => line['msg'])).toContain('export could not be made or recorded');
  });

  test('a run says it is alive; a beat that cannot be written is logged', async () => {
    const world = await aWorld(aMemoryStore(), () => undefined);
    const asked = (await (await (await world.as('ada'))('POST', world.exports)).json()) as {
      id: string;
    };
    const later = aMovableClock();
    later.advance(5 * 60_000);
    await sayAlive(
      { database: cloned.db, clock: later, log: silent, storage: world.store },
      asked.id,
    );
    expect(
      await cloned.db
        .selectFrom('workspace_exports')
        .select('heartbeat_at')
        .where('id', '=', asked.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ heartbeat_at: later.now() });
    const { log, lines } = aRecordingLogger();
    await sayAlive(
      {
        database: aDatabaseThatMustNotBeTouched(new Error('the database is down')),
        clock,
        log,
        storage: world.store,
      },
      asked.id,
    );
    expect(lines.map((line) => line['msg'])).toEqual(['an export could not say it is alive']);
  });

  test('a failure code the contract does not name is shown as the export’s own', async () => {
    const world = await aWorld();
    const id = messageId(new Date(NOW.getTime() - HOUR_MS));
    await cloned.db
      .insertInto('workspace_exports')
      .values({
        id,
        workspace_id: world.room.workspaceId,
        requested_by: world.room.members['ada']?.userId ?? null,
        status: 'failed',
        failure: 'A_CODE_FROM_A_LATER_RELEASE',
        created_at: new Date(NOW.getTime() - HOUR_MS),
      })
      .execute();
    expect(
      (await listOf(await world.as('ada'), world)).find((each) => each.id === id)?.failure,
    ).toBe('EXPORT_FAILED');
  });

  test('the sweep: expired archives claimed then removed; spent ones finished; silent ones failed', async () => {
    const world = await aWorld();
    const { room, store } = world;
    const staleKey = `${room.workspaceId}/exports/stale.tar`;
    const spentKey = `${room.workspaceId}/exports/spent.tar`;
    for (const key of [staleKey, spentKey]) {
      await store.put(key, new Uint8Array([1]), 'application/x-tar');
    }
    const stale = messageId(new Date(NOW.getTime() - 30 * HOUR_MS));
    const making = messageId(new Date(NOW.getTime() - 2 * HOUR_MS));
    await cloned.db
      .insertInto('workspace_exports')
      .values([
        {
          id: stale,
          workspace_id: room.workspaceId,
          requested_by: room.members['ada']?.userId ?? null,
          status: 'ready',
          storage_key: staleKey,
          size_bytes: '1',
          created_at: new Date(NOW.getTime() - 30 * HOUR_MS),
          expires_at: new Date(NOW.getTime() - 6 * HOUR_MS),
        },
        {
          // Downloaded, its delete refused at the time: the row still names it.
          id: messageId(new Date(NOW.getTime() - 20 * HOUR_MS)),
          workspace_id: room.workspaceId,
          requested_by: room.members['ada']?.userId ?? null,
          status: 'downloaded',
          storage_key: spentKey,
          size_bytes: '1',
          created_at: new Date(NOW.getTime() - 20 * HOUR_MS),
          expires_at: new Date(NOW.getTime() + HOUR_MS),
        },
        {
          // Two hours in and still saying so a minute ago: being made, not cut off.
          id: making,
          workspace_id: room.workspaceId,
          requested_by: room.members['ada']?.userId ?? null,
          status: 'pending',
          created_at: new Date(NOW.getTime() - 2 * HOUR_MS),
          heartbeat_at: new Date(NOW.getTime() - 60_000),
        },
      ])
      .execute();
    // The expired one is not there to download, even before the sweep comes.
    const ask = await world.as('ada');
    expect((await ask('GET', `${world.exports}/${stale}/download`)).status).toBe(404);
    const sweep = async (): Promise<Awaited<ReturnType<typeof sweepExports>>> =>
      await sweepExports({ database: cloned.db, clock, storage: store, log: silent });
    // The sweep is the whole database's: other tests' spent rows count in `removed` too.
    const swept = await sweep();
    expect(swept).toMatchObject({ expired: 1, leftBehind: 0, abandoned: 0 });
    expect(swept.removed).toBeGreaterThanOrEqual(2);
    expect(store.keys()).toEqual([]);
    expect((await listOf(ask, world)).find((each) => each.id === stale)?.status).toBe('expired');

    // Silent for longer than it may be: cut off.
    await cloned.db
      .updateTable('workspace_exports')
      .set({ heartbeat_at: new Date(NOW.getTime() - HOUR_MS) })
      .where('id', '=', making)
      .execute();
    expect(await sweep()).toMatchObject({ abandoned: 1 });
    expect(
      await cloned.db
        .selectFrom('workspace_exports')
        .select(['status', 'failure'])
        .where('id', '=', making)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: 'failed', failure: 'EXPORT_ABANDONED' });
  });

  test('the sweep reports an archive the store will not let go, and tries again next time', async () => {
    const world = await aWorld();
    const { room, store } = world;
    const key = `${room.workspaceId}/exports/stuck.tar`;
    await store.put(key, new Uint8Array([1]), 'application/x-tar');
    await cloned.db
      .insertInto('workspace_exports')
      .values({
        id: messageId(new Date(NOW.getTime() - 3 * HOUR_MS)),
        workspace_id: room.workspaceId,
        status: 'downloaded',
        storage_key: key,
        size_bytes: '1',
        created_at: new Date(NOW.getTime() - 3 * HOUR_MS),
        expires_at: new Date(NOW.getTime() + HOUR_MS),
      })
      .execute();
    store.failing('delete', new Error('the bucket refuses'), 0);
    const sweep = async (): Promise<unknown> =>
      await sweepExports({ database: cloned.db, clock, storage: store, log: silent });
    for (const round of [1, 2]) {
      expect(round).toBeGreaterThan(0);
      expect(
        await sweep().then(
          () => 'swept',
          (error: unknown) => String(error),
        ),
      ).toMatch(/\d+ export archive\(s\) could not be removed from storage/);
    }
    expect(store.keys()).toEqual([key]);
  });
});
