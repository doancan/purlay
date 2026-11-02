/**
 * A person's export of their own data over HTTP (D-241), on a cloned database — made by the process in
 * the background, on connections of its own (D-46).
 *
 * Asked for, made by the process's queue, downloaded once as an archive `tar` opens, with the message
 * the person wrote and not the one beside it somebody else wrote. Theirs alone: nobody else lists or
 * downloads it. Once; not after it expired; one at a time, two asks at once making one; at most
 * `PERSONAL_EXPORTS_PER_DAY` a day; signed out refused; an account suspended or erased before it is made
 * is not exported for, and erasure takes the archive with it. On the server's trail, and swept.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cloneIntegrationDatabase,
  type ClonedDatabase,
  CLONE_HOOK_MS,
  DROP_HOOK_MS,
  sql,
} from '@purlay/db';
import { PERSONAL_EXPORTS_PER_DAY, messageId, type WorkspaceExport } from '@purlay/types';
import { HOUR_MS } from '../../platform/clock';
import { SESSION_COOKIE } from '../../platform/cookies';
import { createLogger } from '../../platform/logging';
import { personPrefix } from '../../platform/storage';
import {
  NOW,
  aDatabaseThatMustNotBeTouched,
  aMovableClock,
  aRecordingLogger,
  testDependencies,
} from '../../testing/doubles';
import { aRoom, type Room } from '../../testing/rooms';
import { aMemoryStore, type MemoryStore } from '../../testing/storage';
import { aSession } from '../../testing/signed-in';
import { sendMessage } from '../../modules/messages/messages';
import { exportQueue } from '../../modules/export/queue';
import { sweepExports } from '../../modules/export/requests';
import { endPersonalExports } from '../../modules/export/personal-requests';
import { createApp } from './app';

let cloned: ClonedDatabase;

beforeAll(async () => {
  cloned = await cloneIntegrationDatabase();
}, CLONE_HOOK_MS);

afterAll(async () => {
  await cloned.drop();
}, DROP_HOOK_MS);

const ORIGIN = 'https://purlay.test';
const MINE = '/api/me/exports';
const silent = createLogger({ level: 'silent' });

type Caller = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<Response>;

interface World {
  readonly room: Room;
  readonly store: MemoryStore;
  readonly clock: ReturnType<typeof aMovableClock>;
  readonly as: (name: string) => Promise<Caller>;
  readonly settled: () => Promise<void>;
  /** The exports asked for and held back, when the world holds them. */
  readonly waiting: string[];
  /** Starts every export held back. */
  readonly release: () => void;
}

/**
 * ada and bob share a workspace; the process's own queue makes the exports, as production has it. With
 * `held`, an export asked for waits until the test releases it.
 */
const aWorld = async (options: { readonly held?: boolean } = {}): Promise<World> => {
  const store = aMemoryStore();
  const clock = aMovableClock();
  const room = await aRoom(cloned.db, ['ada', 'bob']);
  const queue = exportQueue({ database: cloned.db, clock, log: silent, storage: store });
  const waiting: string[] = [];
  const app = createApp(
    testDependencies({
      database: cloned.db,
      clock,
      storage: store,
      personalExportRunner: (id): void => {
        if (options.held === true) waiting.push(id);
        else queue.startPersonal(id);
      },
    }),
  );
  return {
    room,
    store,
    clock,
    settled: queue.settled,
    waiting,
    release: (): void => {
      for (const id of waiting.splice(0)) queue.startPersonal(id);
    },
    as: async (name): Promise<Caller> => {
      const person = room.members[name];
      if (person === undefined) throw new Error(`no ${name}`);
      const { token } = await aSession(cloned.db, clock, person.userId, 30);
      return async (method, path, body): Promise<Response> =>
        await app.handle(
          new Request(`${ORIGIN}${path}`, {
            method,
            headers: {
              cookie: `${SESSION_COOKIE}=${token}`,
              origin: ORIGIN,
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
    },
  };
};

const codeOf = async (response: Response): Promise<[number, string]> => [
  response.status,
  ((await response.json()) as { error: { code: string } }).error.code,
];

const listOf = async (caller: Caller): Promise<WorkspaceExport[]> =>
  (await (await caller('GET', MINE)).json()) as WorkspaceExport[];

/** Asks as this caller and waits until the queue has made it. */
const made = async (caller: Caller, world: World): Promise<WorkspaceExport> => {
  const asked = await caller('POST', MINE);
  expect(asked.status).toBe(202);
  const { id } = (await asked.json()) as WorkspaceExport;
  await world.settled();
  const found = (await listOf(caller)).find((each) => each.id === id);
  if (found === undefined) throw new Error('the export is not listed');
  return found;
};

const userOf = (world: World, name: string): string => {
  const id = world.room.members[name]?.userId;
  if (id === undefined) throw new Error(`no ${name}`);
  return id;
};

const rowsOf = async (
  userId: string,
): Promise<{ status: string; failure: string | null; storage_key: string | null }[]> =>
  await cloned.db
    .selectFrom('personal_exports')
    .select(['status', 'failure', 'storage_key'])
    .where('user_id', '=', userId)
    .orderBy('id')
    .execute();

describe('integration: a person’s export of their own data', () => {
  test('asked, made, downloaded once: their words and not the next person’s, theirs alone, on the trail', async () => {
    const world = await aWorld();
    const ada = world.room.members['ada'];
    const bob = world.room.members['bob'];
    if (ada === undefined || bob === undefined) throw new Error('no people');
    await sendMessage(cloned.db, world.clock, ada.context, {
      id: messageId(NOW),
      content: 'Şu mesajı ben yazdım — ada',
    });
    await sendMessage(cloned.db, world.clock, bob.context, {
      id: messageId(new Date(NOW.getTime() + 1)),
      content: 'bob’s words, in the same channel',
    });

    const ask = await world.as('ada');
    const ready = await made(ask, world);
    expect(ready).toMatchObject({ status: 'ready', failure: null });
    expect(ready.expiresAt).toBe(new Date(NOW.getTime() + 24 * HOUR_MS).toISOString());
    expect(world.store.keys()).toEqual([`${personPrefix(ada.userId)}exports/${ready.id}.tar`]);

    // Somebody else: not listed, not downloadable — the same answer as one that is not there.
    const other = await world.as('bob');
    expect(await listOf(other)).toEqual([]);
    const path = `${MINE}/${ready.id}/download`;
    expect(await codeOf(await other('GET', path))).toEqual([404, 'EXPORT_NOT_FOUND']);

    const download = await ask('GET', path);
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toBe('application/x-tar');
    expect(download.headers.get('content-disposition')).toMatch(
      /^attachment; filename="purlay-data-\d{4}-\d{2}-\d{2}\.tar"$/,
    );
    expect(download.headers.get('cache-control')).toBe('no-store');
    const bytes = new Uint8Array(await download.arrayBuffer());
    expect(bytes.length).toBe(ready.sizeBytes ?? -1);
    const scratch = await mkdtemp(join(tmpdir(), 'purlay-personal-test-'));
    await writeFile(join(scratch, 'export.tar'), bytes);
    expect(Bun.spawnSync(['tar', '-xf', join(scratch, 'export.tar'), '-C', scratch]).exitCode).toBe(
      0,
    );
    const messages = await readFile(join(scratch, 'export', 'messages.ndjson'), 'utf8');
    expect(messages).toContain('Şu mesajı ben yazdım — ada');
    expect(messages).not.toContain('bob’s words');
    const manifest = JSON.parse(
      await readFile(join(scratch, 'export', 'manifest.json'), 'utf8'),
    ) as { scope: string; person: { id: string } };
    expect(manifest).toMatchObject({ scope: 'person', person: { id: ada.userId } });

    // Once: the second is not found, the archive left the store, and the list says downloaded.
    expect(await codeOf(await ask('GET', path))).toEqual([404, 'EXPORT_NOT_FOUND']);
    expect(world.store.keys()).toEqual([]);
    expect((await listOf(ask)).find((each) => each.id === ready.id)?.status).toBe('downloaded');
    expect(
      await cloned.db
        .selectFrom('server_audit_log')
        .select(['action', 'actor_user_id', 'target_user_id'])
        .where('actor_user_id', '=', ada.userId)
        .orderBy('action')
        .execute(),
    ).toEqual([
      {
        action: 'account.export_downloaded',
        actor_user_id: ada.userId,
        target_user_id: ada.userId,
      },
      { action: 'account.export_requested', actor_user_id: ada.userId, target_user_id: ada.userId },
    ]);
  });

  test('signed out: refused, and nothing asked for', async () => {
    const world = await aWorld();
    const app = createApp(testDependencies({ database: cloned.db }));
    for (const [method, path] of [
      ['POST', MINE],
      ['GET', MINE],
      ['GET', `${MINE}/${messageId(NOW)}/download`],
    ] as const) {
      const response = await app.handle(
        new Request(`${ORIGIN}${path}`, { method, headers: { origin: ORIGIN } }),
      );
      expect(await codeOf(response)).toEqual([401, 'UNAUTHENTICATED']);
    }
    expect(await rowsOf(userOf(world, 'ada'))).toEqual([]);
  });

  test('an id that is no id, or another person’s, or a workspace export’s: not found', async () => {
    const world = await aWorld();
    const ask = await world.as('ada');
    for (const id of ['not-a-uuid', '1', "0' or '1'='1", messageId(NOW)]) {
      expect(await codeOf(await ask('GET', `${MINE}/${encodeURIComponent(id)}/download`))).toEqual([
        404,
        'EXPORT_NOT_FOUND',
      ]);
    }
  });

  test('past its expiry: not served, even before the sweep; the sweep then takes it', async () => {
    const world = await aWorld();
    const ask = await world.as('ada');
    const ready = await made(ask, world);
    world.clock.advance(24 * HOUR_MS);
    expect(await codeOf(await ask('GET', `${MINE}/${ready.id}/download`))).toEqual([
      404,
      'EXPORT_NOT_FOUND',
    ]);
    expect(world.store.keys()).toHaveLength(1);
    const swept = await sweepExports({
      database: cloned.db,
      clock: world.clock,
      storage: world.store,
      log: silent,
    });
    expect(swept.expired).toBeGreaterThanOrEqual(1);
    expect(world.store.keys()).toEqual([]);
    expect(await rowsOf(userOf(world, 'ada'))).toEqual([
      { status: 'expired', failure: null, storage_key: null },
    ]);
  });

  test('one at a time; two asks at once make one export', async () => {
    const world = await aWorld({ held: true });
    const ask = await world.as('ada');
    const answers = await Promise.all([ask('POST', MINE), ask('POST', MINE), ask('POST', MINE)]);
    const statuses = answers.map((answer) => answer.status).sort();
    expect(statuses).toEqual([202, 409, 409]);
    for (const answer of answers.filter((each) => each.status === 409)) {
      expect(await codeOf(answer)).toEqual([409, 'EXPORT_IN_PROGRESS']);
    }
    expect(await rowsOf(userOf(world, 'ada'))).toHaveLength(1);
    // Somebody else's is their own: bob may ask while ada's is being made.
    expect((await (await world.as('bob'))('POST', MINE)).status).toBe(202);
    world.release();
    await world.settled();
    expect((await rowsOf(userOf(world, 'ada'))).map((row) => row.status)).toEqual(['ready']);
  });

  test(`at most ${String(PERSONAL_EXPORTS_PER_DAY)} a day, then refused with when to ask again`, async () => {
    const world = await aWorld();
    const ask = await world.as('ada');
    for (let asked = 0; asked < PERSONAL_EXPORTS_PER_DAY; asked += 1) {
      await made(ask, world);
      world.clock.advance(HOUR_MS);
    }
    const refused = await ask('POST', MINE);
    expect(refused.headers.get('retry-after')).toBe(String((24 - PERSONAL_EXPORTS_PER_DAY) * 3600));
    expect(await codeOf(refused)).toEqual([429, 'RATE_LIMITED']);
    expect(await rowsOf(userOf(world, 'ada'))).toHaveLength(PERSONAL_EXPORTS_PER_DAY);
    // A day after the first, one more may be asked.
    world.clock.advance((24 - PERSONAL_EXPORTS_PER_DAY) * HOUR_MS);
    expect((await ask('POST', MINE)).status).toBe(202);
  });

  test('an account suspended before it is made is not exported for', async () => {
    const world = await aWorld({ held: true });
    const ask = await world.as('ada');
    expect((await ask('POST', MINE)).status).toBe(202);
    await cloned.db
      .updateTable('users')
      .set({ suspended_at: NOW })
      .where('id', '=', userOf(world, 'ada'))
      .execute();
    world.release();
    await world.settled();
    expect(await rowsOf(userOf(world, 'ada'))).toEqual([
      { status: 'failed', failure: 'EXPORT_REQUESTER_GONE', storage_key: null },
    ]);
    expect(world.store.keys()).toEqual([]);
  });

  test('erasing the account ends its exports and the sweep takes the archive; one waiting is never made', async () => {
    const world = await aWorld({ held: true });
    const ada = world.room.members['ada'];
    if (ada === undefined) throw new Error('no ada');
    const ask = await world.as('ada');
    expect((await ask('POST', MINE)).status).toBe(202);
    world.release();
    await world.settled();
    const [ready] = await rowsOf(ada.userId);
    expect(ready?.status).toBe('ready');
    world.clock.advance(HOUR_MS);
    // And another, asked and not yet made when the account goes.
    expect((await ask('POST', MINE)).status).toBe(202);
    // Erasing needs a recent sign-in, and somebody else to own the workspace (D-139 §5–§6).
    await cloned.db
      .updateTable('workspace_members')
      .set({ role: 'owner' })
      .where('user_id', '=', userOf(world, 'bob'))
      .execute();
    const recent = await world.as('ada');
    const erased = await recent('POST', '/api/me/erase', { confirm: ada.username });
    expect(erased.status).toBe(204);
    expect(await rowsOf(ada.userId)).toEqual([
      { status: 'expired', failure: null, storage_key: ready?.storage_key ?? '' },
      { status: 'failed', failure: 'EXPORT_REQUESTER_GONE', storage_key: null },
    ]);
    // The one held back finds itself given up: no second archive is made.
    world.release();
    await world.settled();
    expect(world.store.keys()).toEqual([ready?.storage_key ?? '']);
    await sweepExports({
      database: cloned.db,
      clock: world.clock,
      storage: world.store,
      log: silent,
    });
    expect(world.store.keys()).toEqual([]);
    expect((await rowsOf(ada.userId)).map((row) => row.storage_key)).toEqual([null, null]);
  });

  test('a run cut off is marked so by the sweep; a store that refuses fails it by a code', async () => {
    const world = await aWorld({ held: true });
    const ask = await world.as('ada');
    expect((await ask('POST', MINE)).status).toBe(202);
    world.clock.advance(HOUR_MS);
    expect(
      await sweepExports({
        database: cloned.db,
        clock: world.clock,
        storage: world.store,
        log: silent,
      }),
    ).toMatchObject({ abandoned: 1 });
    expect(await rowsOf(userOf(world, 'ada'))).toEqual([
      { status: 'failed', failure: 'EXPORT_ABANDONED', storage_key: null },
    ]);

    world.store.failing('put', new Error('the bucket is gone'));
    const bob = await world.as('bob');
    expect((await bob('POST', MINE)).status).toBe(202);
    world.release();
    await world.settled();
    expect(await listOf(bob)).toMatchObject([{ status: 'failed', failure: 'EXPORT_FAILED' }]);
    expect(world.store.keys()).toEqual([]);
  });

  test('given up on while its archive was stored: the archive goes, and one the store keeps is logged by key', async () => {
    for (const refuses of [false, true]) {
      const world = await aWorld({ held: true });
      const ada = userOf(world, 'ada');
      expect((await (await world.as('ada'))('POST', MINE)).status).toBe(202);
      const { log, lines } = aRecordingLogger();
      const store: MemoryStore = {
        ...world.store,
        putFile: async (key, path, type): Promise<void> => {
          await world.store.putFile(key, path, type);
          // The account erased meanwhile.
          await cloned.db.transaction().execute(async (erasing) => {
            await endPersonalExports(erasing, world.clock, ada);
          });
        },
      };
      if (refuses) world.store.failing('delete', new Error('the bucket refuses'));
      const queue = exportQueue({ database: cloned.db, clock: world.clock, log, storage: store });
      for (const id of world.waiting.splice(0)) queue.startPersonal(id);
      await queue.settled();
      expect(world.store.keys()).toHaveLength(refuses ? 1 : 0);
      const said = lines.find(
        (line) => line['msg'] === 'a failed export’s archive could not be removed from storage',
      );
      expect(said?.['key'] ?? null).toBe(refuses ? (world.store.keys()[0] ?? '') : null);
      expect(await rowsOf(ada)).toEqual([
        { status: 'failed', failure: 'EXPORT_REQUESTER_GONE', storage_key: null },
      ]);
    }
  });

  test('a failure it cannot even record is logged, and the queue goes on', async () => {
    const { log, lines } = aRecordingLogger();
    const queue = exportQueue({
      database: aDatabaseThatMustNotBeTouched(new Error('the database is down')),
      clock: aMovableClock(),
      log,
      storage: aMemoryStore(),
    });
    queue.startPersonal(messageId(NOW));
    await queue.settled();
    expect(lines.map((line) => line['msg'])).toContain(
      'a person’s export could not be made or recorded',
    );
  });

  test('a download racing the account’s erasure: they take turns, and nobody meets a deadlock', async () => {
    const world = await aWorld();
    const ada = userOf(world, 'ada');
    const ask = await world.as('ada');
    const ready = await made(ask, world);
    // The erasure's order: the person's row first, then their exports (`erasure.ts`).
    let downloading: Promise<Response> | undefined;
    await cloned.db.transaction().execute(async (erasing) => {
      await erasing.selectFrom('users').select('id').where('id', '=', ada).forUpdate().execute();
      downloading = ask('GET', `${MINE}/${ready.id}/download`);
      expect(await waitingOnALock()).toBe(true);
      await endPersonalExports(erasing, world.clock, ada);
    });
    // The download waited for the erasure, and found its export no longer to be had.
    expect(await codeOf(await (downloading ?? Promise.reject(new Error('never asked'))))).toEqual([
      404,
      'EXPORT_NOT_FOUND',
    ]);
    expect((await rowsOf(ada)).map((row) => row.status)).toEqual(['expired']);
  });
});

/** Whether a statement is waiting on a lock, asked of the database until one is. */
const waitingOnALock = async (): Promise<boolean> => {
  for (let look = 0; look < 500; look += 1) {
    const { rows } = await sql<{ count: number }>`
      select count(*)::int as count from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`.execute(cloned.db);
    if ((rows[0]?.count ?? 0) > 0) return true;
  }
  return false;
};
