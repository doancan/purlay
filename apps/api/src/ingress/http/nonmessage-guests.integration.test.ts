/** Timestamped channel collaboration content must not bypass a guest's current share boundary. */
import { afterAll, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { closeIntegrationDatabase, sql, withRollback, type Transaction } from '@purlay/db';
import {
  BookmarkList,
  IncidentResponse,
  messageId,
  ChannelBookmark,
  BOOKMARKS_MAX,
  Incident,
  IncidentUpdatePage,
  ErrorResponse,
} from '@purlay/types';
import { fixedClock, type Clock } from '../../platform/clock';
import { SESSION_COOKIE } from '../../platform/cookies';
import { createApp } from './app';
import { testDependencies } from '../../testing/doubles';
import { aRoom, type Room } from '../../testing/rooms';
import { aSession } from '../../testing/signed-in';
import { attempt, inSavepoint } from '../../testing/attempt';
import {
  addBookmark,
  channelBookmarks,
  removeBookmark,
} from '../../features/chat/bookmarks/bookmarks';
import {
  changeIncident,
  incidentUpdates,
  channelIncident,
  declareIncident,
  savePostmortem,
} from '../../features/chat/incidents/incidents';
import { addResponder, removeResponder } from '../../features/chat/incidents/responders';
import { requireChannelById, type ChannelContext } from '../../features/chat/channels/guard';

afterAll(async () => {
  await closeIntegrationDatabase();
});

interface Setup {
  readonly room: Room;
  readonly owner: ChannelContext;
  readonly guest: ChannelContext;
  readonly formerFull: ChannelContext;
  readonly oldBookmark: ChannelBookmark;
  readonly freshBookmark: ChannelBookmark;
  readonly oldIncidentId: string;
  readonly oldClock: Clock;
  readonly freshClock: Clock;
  readonly floor: Date;
}

const fixture = async (
  db: Transaction,
  later: 'admission' | 'channel' = 'channel',
): Promise<Setup> => {
  const room = await aRoom(db, ['owner', 'guest', 'responder']);
  const owner = room.members['owner']?.context;
  const formerFull = room.members['guest']?.context;
  const responder = room.members['responder'];
  if (owner === undefined || formerFull === undefined || responder === undefined)
    throw new Error('Missing fixture member');
  const base = await db
    .selectNoFrom(sql<Date>`statement_timestamp() - interval '5 minutes'`.as('at'))
    .executeTakeFirstOrThrow();
  const time = (seconds: number): Date => new Date(base.at.getTime() + seconds * 1000);
  const oldClock = fixedClock(time(30));
  const freshClock = fixedClock(time(90));
  const oldBookmark = (
    await addBookmark(db, oldClock, owner, {
      url: 'https://private.example/prior-contract',
      title: 'Private pre-admission contract',
    })
  ).bookmark;
  const freshBookmark = (
    await addBookmark(db, freshClock, owner, {
      url: 'https://shared.example/current-contract',
      title: 'Current shared contract',
    })
  ).bookmark;
  const oldIncidentId = messageId(time(3600));
  await declareIncident(db, oldClock, owner, { id: oldIncidentId, severity: 2 });
  await changeIncident(db, oldClock, owner, oldIncidentId, {
    runbookUrl: 'https://private.example/prior-runbook',
  });
  await savePostmortem(db, oldClock, owner, oldIncidentId, {
    content: 'Private pre-admission postmortem',
    version: 0,
  });
  await addResponder(db, oldClock, owner, oldIncidentId, responder.userId);
  await db
    .updateTable('users')
    .set({ email_verified: true })
    .where('id', '=', formerFull.userId)
    .execute();
  await db
    .updateTable('workspace_members')
    .set({
      access_kind: 'guest',
      guest_since: time(later === 'admission' ? 60 : 0),
      guest_expires_at: null,
      guest_modules: ['chat'],
    })
    .where('workspace_id', '=', room.workspaceId)
    .where('user_id', '=', formerFull.userId)
    .execute();
  await db
    .updateTable('channel_members')
    .set({ joined_at: time(later === 'channel' ? 60 : 0) })
    .where('channel_id', '=', room.channelId)
    .where('user_id', '=', formerFull.userId)
    .execute();
  const guest = await requireChannelById(db, formerFull.userId, room.channelId);
  return {
    room,
    owner,
    guest,
    formerFull,
    oldBookmark,
    freshBookmark,
    oldIncidentId,
    oldClock,
    freshClock,
    floor: time(60),
  };
};

const caller = async (
  db: Transaction,
  clock: Clock,
  userId: string,
): Promise<(method: string, path: string, body?: unknown) => Promise<Response>> => {
  const { token } = await aSession(db, clock, userId, 30);
  const app = createApp(testDependencies({ database: db, clock }));
  return async (method, path, body) =>
    await app.handle(
      new Request(`https://purlay.test${path}`, {
        method,
        headers: {
          cookie: `${SESSION_COOKIE}=${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
};

const freshIncident = async (db: Transaction, setup: Setup): Promise<string> => {
  await changeIncident(db, setup.oldClock, setup.owner, setup.oldIncidentId, {
    status: 'resolved',
  });
  const id = messageId(new Date(setup.floor.getTime() - 60_000));
  await declareIncident(db, setup.freshClock, setup.owner, { id, severity: 1 });
  await savePostmortem(db, setup.freshClock, setup.owner, id, {
    content: 'Current shared postmortem',
    version: 0,
  });
  return id;
};

describe('integration: guest timestamped channel content', () => {
  test.each(['admission', 'channel'] as const)(
    'the later %s boundary hides old bookmark words/identities in the actual HTTP response',
    async (later) => {
      await withRollback(async (db) => {
        const setup = await fixture(db, later);
        const full = await caller(db, setup.freshClock, setup.owner.userId);
        const guest = await caller(db, setup.freshClock, setup.guest.userId);
        const path = `/api/channels/${setup.room.channelId}/bookmarks`;
        const fullResponse = await full('GET', path);
        expect(fullResponse.status).toBe(200);
        const fullData: unknown = await fullResponse.json();
        if (!Value.Check(BookmarkList, fullData))
          throw new Error('Malformed full bookmark response');
        expect(fullData.some((row) => row.id === setup.oldBookmark.id)).toBe(true);
        const response = await guest('GET', path);
        expect(response.status).toBe(200);
        const data: unknown = await response.json();
        if (!Value.Check(BookmarkList, data)) throw new Error('Malformed guest bookmark response');
        expect(data.map((row) => row.id)).toEqual([setup.freshBookmark.id]);
        expect(JSON.stringify(data).includes(setup.oldBookmark.url)).toBe(false);
      });
    },
  );

  test('an earlier incident and its private writeup are absent from the actual guest HTTP response', async () => {
    await withRollback(async (db) => {
      const setup = await fixture(db);
      const full = await caller(db, setup.freshClock, setup.owner.userId);
      const guest = await caller(db, setup.freshClock, setup.guest.userId);
      const path = `/api/channels/${setup.room.channelId}/incident`;
      const fullData: unknown = await (await full('GET', path)).json();
      if (!Value.Check(IncidentResponse, fullData))
        throw new Error('Malformed full incident response');
      expect(fullData.incident?.postmortem).toBe('Private pre-admission postmortem');
      const response = await guest('GET', path);
      expect(response.status).toBe(200);
      const data: unknown = await response.json();
      if (!Value.Check(IncidentResponse, data))
        throw new Error('Malformed guest incident response');
      expect(data.incident === null).toBe(true);
    });
  });

  test('a guessed old incident timeline has no direct HTTP bypass', async () => {
    await withRollback(async (db) => {
      const setup = await fixture(db);
      const guest = await caller(db, setup.freshClock, setup.guest.userId);
      const response = await guest(
        'GET',
        `/api/channels/${setup.room.channelId}/incident/${setup.oldIncidentId}/updates`,
      );
      expect(response.status).toBe(404);
    });
  });

  test('fresh incident content is usable even when its client identifier predates the guest boundary', async () => {
    await withRollback(async (db) => {
      const setup = await fixture(db);
      const id = await freshIncident(db, setup);
      const guest = await caller(db, setup.freshClock, setup.guest.userId);
      const response = await guest('GET', `/api/channels/${setup.room.channelId}/incident`);
      expect(response.status).toBe(200);
      const data: unknown = await response.json();
      if (!Value.Check(IncidentResponse, data))
        throw new Error('Malformed fresh incident response');
      expect(data.incident?.id).toBe(id);
      expect(data.incident?.postmortem).toBe('Current shared postmortem');
    });
  });

  test('a captured former full-member context cannot bypass the current guest floor', async () => {
    await withRollback(async (db) => {
      const setup = await fixture(db);
      expect(setup.formerFull.guest === undefined).toBe(true);
      expect((await channelBookmarks(db, setup.formerFull)).map((row) => row.id)).toEqual([
        setup.freshBookmark.id,
      ]);
      expect((await channelIncident(db, setup.formerFull)) === null).toBe(true);
    });
  });

  test.each(['scope', 'expired', 'module'] as const)(
    'a stale context cannot read current records after %s loss',
    async (loss) => {
      await withRollback(async (db) => {
        const setup = await fixture(db);
        await freshIncident(db, setup);
        expect(
          (await channelBookmarks(db, setup.guest)).some(
            (row) => row.id === setup.freshBookmark.id,
          ),
        ).toBe(true);
        expect((await channelIncident(db, setup.guest))?.postmortem).toBe(
          'Current shared postmortem',
        );
        if (loss === 'scope')
          await db
            .deleteFrom('channel_members')
            .where('channel_id', '=', setup.room.channelId)
            .where('user_id', '=', setup.guest.userId)
            .execute();
        else
          await db
            .updateTable('workspace_members')
            .set(
              loss === 'expired'
                ? { guest_expires_at: sql<Date>`statement_timestamp() - interval '1 second'` }
                : { guest_modules: ['issues'] },
            )
            .where('workspace_id', '=', setup.room.workspaceId)
            .where('user_id', '=', setup.guest.userId)
            .execute();
        expect(await channelBookmarks(db, setup.guest)).toEqual([]);
        expect((await channelIncident(db, setup.guest)) === null).toBe(true);
      });
    },
  );

  test('the exact stored share boundary is included, regardless of the bookmark UUID', async () => {
    await withRollback(async (db) => {
      const setup = await fixture(db);
      await db
        .updateTable('channel_bookmarks')
        .set({ added_at: setup.floor })
        .where('id', '=', setup.freshBookmark.id)
        .execute();
      await db
        .updateTable('incidents')
        .set({ declared_at: setup.floor })
        .where('id', '=', setup.oldIncidentId)
        .execute();
      expect((await channelBookmarks(db, setup.guest)).map((row) => row.id)).toEqual([
        setup.freshBookmark.id,
      ]);
      expect((await channelIncident(db, setup.guest))?.id).toBe(setup.oldIncidentId);
    });
  });

  test('a known hidden URL is freshly shared without echoing its old title, author, time or identifier', async () => {
    await withRollback(async (db) => {
      const setup = await fixture(db);
      const guest = await caller(db, setup.freshClock, setup.guest.userId);
      const path = `/api/channels/${setup.room.channelId}/bookmarks`;
      const response = await guest('POST', path, {
        url: setup.oldBookmark.url,
        title: 'Our new share',
      });
      expect(response.status).toBe(201);
      const data: unknown = await response.json();
      if (!Value.Check(ChannelBookmark, data)) throw new Error('Malformed new bookmark response');
      expect(data.id === setup.oldBookmark.id).toBe(false);
      expect(data.title).toBe('Our new share');
      expect(data.addedBy?.id).toBe(setup.guest.userId);
      expect(data.addedAt).toBe(setup.freshClock.now().toISOString());
      const retry = await addBookmark(db, setup.freshClock, setup.guest, {
        url: setup.oldBookmark.url,
        title: 'Retried name',
      });
      expect(retry.change.changed).toBe(false);
      expect(retry.bookmark).toEqual(data);
      expect(
        (await channelBookmarks(db, setup.owner)).some((row) => row.id === setup.oldBookmark.id),
      ).toBe(false);
    });
  });

  test('fresh sharing a hidden URL at the header limit replaces one slot without increasing the bound', async () => {
    await withRollback(async (db) => {
      const setup = await fixture(db);
      for (let index = 2; index < BOOKMARKS_MAX; index += 1) {
        await addBookmark(db, setup.oldClock, setup.owner, {
          url: `https://private.example/slot-${String(index)}`,
          title: 'Private old slot',
        });
      }
      const shared = await addBookmark(db, setup.freshClock, setup.guest, {
        url: setup.oldBookmark.url,
        title: 'Fresh title',
      });
      expect(shared.change.changed).toBe(true);
      expect(shared.bookmark.addedBy?.id).toBe(setup.guest.userId);
      expect(await channelBookmarks(db, setup.owner)).toHaveLength(BOOKMARKS_MAX);
      expect(await channelBookmarks(db, setup.guest)).toHaveLength(2);
    });
  });

  test('an old bookmark identifier is the same not-found as an unknown one, with the old row preserved', async () => {
    await withRollback(async (db) => {
      const setup = await fixture(db);
      const guest = await caller(db, setup.freshClock, setup.guest.userId);
      const response = await guest(
        'DELETE',
        `/api/channels/${setup.room.channelId}/bookmarks/${setup.oldBookmark.id}`,
      );
      expect(response.status).toBe(404);
      expect(
        (await channelBookmarks(db, setup.owner)).some((row) => row.id === setup.oldBookmark.id),
      ).toBe(true);
      await removeBookmark(db, setup.guest, setup.freshBookmark.id);
      expect(await channelBookmarks(db, setup.guest)).toEqual([]);
    });
  });

  test.each(['declaration', 'status', 'postmortem', 'responder-add', 'responder-remove'] as const)(
    'a hidden incident cannot be exposed or changed through %s',
    async (operation) => {
      await withRollback(async (db) => {
        const setup = await fixture(db);
        const guest = await caller(db, setup.freshClock, setup.guest.userId);
        const root = `/api/channels/${setup.room.channelId}/incident`;
        const id = setup.oldIncidentId;
        const responder = setup.room.members['responder'];
        if (responder === undefined) throw new Error('Missing responder');
        const response =
          operation === 'declaration'
            ? await guest('POST', root, { id, severity: 2 })
            : operation === 'status'
              ? await guest('PATCH', `${root}/${id}`, { severity: 3 })
              : operation === 'postmortem'
                ? await guest('PUT', `${root}/${id}/postmortem`, {
                    content: 'Replaced private words',
                    version: 1,
                  })
                : await guest(
                    operation === 'responder-add' ? 'PUT' : 'DELETE',
                    `${root}/${id}/responders/${responder.userId}`,
                  );
        expect(response.status).toBe(404);
        expect((await channelIncident(db, setup.owner))?.postmortem).toBe(
          'Private pre-admission postmortem',
        );
        expect((await channelIncident(db, setup.owner))?.severity).toBe(2);
        expect(
          (await channelIncident(db, setup.owner))?.responders.some(
            (row) => row.id === responder.userId,
          ),
        ).toBe(true);
      });
    },
  );

  test('fresh incident edits, responders, timeline and idempotent echoes remain available to an assigned guest', async () => {
    await withRollback(async (db) => {
      const setup = await fixture(db);
      const id = await freshIncident(db, setup);
      const guest = await caller(db, setup.freshClock, setup.guest.userId);
      const root = `/api/channels/${setup.room.channelId}/incident`;
      const changed = await guest('PATCH', `${root}/${id}`, { severity: 3 });
      expect(changed.status).toBe(200);
      const data: unknown = await changed.json();
      if (!Value.Check(Incident, data)) throw new Error('Malformed incident edit');
      expect(data.severity).toBe(3);
      await savePostmortem(db, setup.freshClock, setup.guest, id, {
        content: 'Guest writeup',
        version: 1,
      });
      const added = await addResponder(db, setup.freshClock, setup.guest, id, setup.guest.userId);
      expect(added.incident.responders.some((row) => row.id === setup.guest.userId)).toBe(true);
      expect(
        (await addResponder(db, setup.freshClock, setup.guest, id, setup.guest.userId)).changed,
      ).toBe(false);
      expect(
        (await removeResponder(db, setup.freshClock, setup.guest, id, setup.guest.userId)).changed,
      ).toBe(true);
      const retry = await declareIncident(db, setup.freshClock, setup.guest, { id, severity: 1 });
      expect(retry.changed).toBe(false);
      expect(retry.incident.postmortem).toBe('Guest writeup');
      const timeline = await guest('GET', `${root}/${id}/updates?limit=2`);
      expect(timeline.status).toBe(200);
      const page: unknown = await timeline.json();
      if (!Value.Check(IncidentUpdatePage, page)) throw new Error('Malformed incident timeline');
      expect(page.data).toHaveLength(2);
      expect(page.nextCursor === null).toBe(false);
      expect(page.data.some((row) => row.actor?.id === setup.guest.userId)).toBe(true);
    });
  });

  test.each(['bookmark', 'incident'] as const)(
    'a captured guest context cannot write %s after its chat module is removed',
    async (kind) => {
      await withRollback(async (db) => {
        const setup = await fixture(db);
        const id = await freshIncident(db, setup);
        await db
          .updateTable('workspace_members')
          .set({ guest_modules: ['issues'] })
          .where('workspace_id', '=', setup.room.workspaceId)
          .where('user_id', '=', setup.guest.userId)
          .execute();
        const failure = await attempt(db, async () =>
          kind === 'bookmark'
            ? await addBookmark(db, setup.freshClock, setup.guest, {
                url: 'https://shared.example/refused',
                title: 'Refused',
              })
            : await changeIncident(db, setup.freshClock, setup.guest, id, { severity: 4 }),
        );
        expect(failure).toBe('CHANNEL_NOT_FOUND');
        expect(
          (await channelBookmarks(db, setup.owner)).some(
            (row) => row.url === 'https://shared.example/refused',
          ),
        ).toBe(false);
        expect((await channelIncident(db, setup.owner))?.severity).toBe(1);
      });
    },
  );

  test.each(['suspended', 'erased'] as const)(
    'current content also closes for a captured %s account',
    async (state) => {
      await withRollback(async (db) => {
        const setup = await fixture(db);
        await freshIncident(db, setup);
        expect(
          (await channelBookmarks(db, setup.guest)).some(
            (row) => row.id === setup.freshBookmark.id,
          ),
        ).toBe(true);
        await db
          .updateTable('users')
          .set(
            state === 'suspended'
              ? { suspended_at: setup.freshClock.now() }
              : { deleted_at: setup.freshClock.now() },
          )
          .where('id', '=', setup.guest.userId)
          .execute();
        expect(await channelBookmarks(db, setup.guest)).toEqual([]);
        expect((await channelIncident(db, setup.guest)) === null).toBe(true);
      });
    },
  );

  test('a failed fresh URL replacement rolls back its hidden old row as well as the new share', async () => {
    await withRollback(async (db) => {
      const setup = await fixture(db);
      await sql`create function refuse_guest_share() returns trigger language plpgsql as $$ begin
        if new.title = 'Deliberately failed share' then raise exception 'injected guest share failure'; end if;
        return new;
      end $$`.execute(db);
      await sql`create trigger refuse_guest_share before insert on channel_bookmarks for each row execute function refuse_guest_share()`.execute(
        db,
      );
      const failed = await inSavepoint(
        db,
        async () =>
          await addBookmark(db, setup.freshClock, setup.guest, {
            url: setup.oldBookmark.url,
            title: 'Deliberately failed share',
          }),
      );
      expect(failed.taken).toBe(false);
      expect(
        (await channelBookmarks(db, setup.owner)).some(
          (row) => row.id === setup.oldBookmark.id && row.title === setup.oldBookmark.title,
        ),
      ).toBe(true);
      expect((await channelBookmarks(db, setup.guest)).map((row) => row.id)).toEqual([
        setup.freshBookmark.id,
      ]);
    });
  });

  test('a skewed pre-floor share cannot replace hidden content with an unreadable receipt', async () => {
    await withRollback(async (db) => {
      const setup = await fixture(db);
      const failure = await attempt(
        db,
        async () =>
          await addBookmark(db, setup.oldClock, setup.guest, {
            url: setup.oldBookmark.url,
            title: 'Clock-skewed share',
          }),
      );
      expect(failure).toBe('BOOKMARK_NOT_FOUND');
      expect(
        (await channelBookmarks(db, setup.owner)).some((row) => row.id === setup.oldBookmark.id),
      ).toBe(true);
    });
  });

  test('timeline share times are filtered before pagination, including a future UUID on old words', async () => {
    await withRollback(async (db) => {
      const setup = await fixture(db);
      const id = await freshIncident(db, setup);
      await changeIncident(db, setup.oldClock, setup.owner, id, {
        runbookUrl: 'https://private.example/old-timeline',
      });
      const hidden = await db
        .selectFrom('incident_updates')
        .select('id')
        .where('incident_id', '=', id)
        .where('kind', '=', 'runbook')
        .executeTakeFirstOrThrow();
      await db
        .updateTable('incident_updates')
        .set({ id: messageId(new Date(setup.floor.getTime() + 3_600_000)) })
        .where('id', '=', hidden.id)
        .execute();
      const guest = await caller(db, setup.freshClock, setup.guest.userId);
      const response = await guest(
        'GET',
        `/api/channels/${setup.room.channelId}/incident/${id}/updates?limit=1`,
      );
      expect(response.status).toBe(200);
      const page: unknown = await response.json();
      if (!Value.Check(IncidentUpdatePage, page)) throw new Error('Malformed timestamped timeline');
      expect(page.data).toHaveLength(1);
      expect(page.data[0]?.change.kind).toBe('postmortem');
      expect(page.nextCursor === null).toBe(false);
      expect(JSON.stringify(page).includes('old-timeline')).toBe(false);
    });
  });

  test.each(['status', 'postmortem', 'responder'] as const)(
    'hidden incident %s validation never discloses its private state or target validation',
    async (kind) => {
      await withRollback(async (db) => {
        const setup = await fixture(db);
        await changeIncident(db, setup.oldClock, setup.owner, setup.oldIncidentId, {
          status: 'resolved',
        });
        const guest = await caller(db, setup.freshClock, setup.guest.userId);
        const root = `/api/channels/${setup.room.channelId}/incident/${setup.oldIncidentId}`;
        const response =
          kind === 'status'
            ? await guest('PATCH', root, { severity: 3 })
            : kind === 'postmortem'
              ? await guest('PUT', `${root}/postmortem`, { content: 'Wrong version', version: 0 })
              : await guest('PUT', `${root}/responders/${messageId(setup.floor)}`);
        expect(response.status).toBe(404);
        const data: unknown = await response.json();
        expect(Value.Check(ErrorResponse, data) && data.error.code === 'INCIDENT_NOT_FOUND').toBe(
          true,
        );
      });
    },
  );

  test('a floor changed after the timeline ownership read is enforced again in the final content statement', async () => {
    await withRollback(async (db) => {
      const setup = await fixture(db);
      const id = await freshIncident(db, setup);
      const later = new Date(setup.freshClock.now().getTime() + 30_000);
      await changeIncident(db, fixedClock(later), setup.owner, id, {
        runbookUrl: 'https://shared.example/later-update',
      });
      expect(
        (await incidentUpdates(db, setup.guest, id, {})).data.some(
          (row) => row.change.kind === 'runbook',
        ),
      ).toBe(true);
      let reads = 0;
      const changing = db.withPlugin({
        transformQuery: (args) => args.node,
        transformResult: async (args) => {
          reads += 1;
          if (reads === 1)
            await db
              .updateTable('channel_members')
              .set({ joined_at: new Date(setup.freshClock.now().getTime() + 1) })
              .where('channel_id', '=', setup.room.channelId)
              .where('user_id', '=', setup.guest.userId)
              .execute();
          return args.result;
        },
      });
      const page = await incidentUpdates(changing, setup.guest, id, {});
      expect(reads).toBe(2);
      expect(page.data).toEqual([]);
      expect(page.nextCursor === null).toBe(true);
    });
  });

  test('incident identities and paged timeline people do not add a query per person or entry', async () => {
    await withRollback(async (db) => {
      const setup = await fixture(db);
      const id = await freshIncident(db, setup);
      await addResponder(db, setup.freshClock, setup.owner, id, setup.guest.userId);
      let reads = 0;
      const counted = db.withPlugin({
        transformQuery: (args) => args.node,
        transformResult: (args) => {
          reads += 1;
          return Promise.resolve(args.result);
        },
      });
      const current = await channelIncident(counted, setup.guest);
      expect(current?.responders.some((row) => row.id === setup.guest.userId)).toBe(true);
      expect(reads).toBe(1);
      reads = 0;
      const page = await incidentUpdates(counted, setup.guest, id, { limit: 1 });
      expect(page.data).toHaveLength(1);
      const change = page.data[0]?.change;
      expect(change?.kind === 'responder_added' && change.user?.id === setup.guest.userId).toBe(
        true,
      );
      expect(reads).toBe(2);
      reads = 0;
      const all = await incidentUpdates(counted, setup.guest, id, {});
      expect(all.data.length > page.data.length).toBe(true);
      expect(reads).toBe(2);
    });
  });
});
