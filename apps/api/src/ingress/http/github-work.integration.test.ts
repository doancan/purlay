/**
 * Linking existing GitHub work to a thread, and following it (D-246 §3, `API.md` §7): an issue or pull request is
 * linked after GitHub says the person and the App can both reach it, read with the installation and never with the
 * person's token, one answer for what does not exist and what may not be reached; and the App's signed events
 * keep the link current — dropped when older than what is shown, told only when what the thread shows changed,
 * only for the installation's own workspaces, and never a notification.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { githubIssueMarker, messageId, type GitHubWorkLink } from '@purlay/types';
import {
  aWorld,
  API,
  codeOf,
  create,
  NOW,
  outcomeOf,
  PERSON,
  request,
  rootOf,
  type World,
} from '../../testing/github-world';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const at = (minutes: number): string => new Date(NOW.getTime() + minutes * 60_000).toISOString();

const item = (
  world: World,
  over: Partial<Parameters<World['github']['items']['push']>[0]> = {},
): Parameters<World['github']['items']['push']>[0] => {
  const made = {
    id: 9000 + world.github.items.length,
    number: world.github.items.length + 1,
    kind: 'issue' as const,
    repositoryId: API.id,
    title: 'Retry with jitter',
    body: 'Decided.',
    state: 'open' as const,
    merged: false,
    creator: 'octocat',
    createdAt: at(-60),
    updatedAt: at(-30),
    ...over,
  };
  world.github.items.push(made);
  return made;
};

const link = async (
  world: World,
  url: string,
  who = world.owner,
  at: string = world.rootId,
): Promise<{ status: number; json: unknown }> => {
  const response = await world.call('POST', `/api/messages/${at}/github-link`, who, { url });
  return { status: response.status, json: await response.json() };
};

// By number: the clock stands still in these tests, so the thread's own order (by when) is a tie.
const workOf = async (world: World): Promise<GitHubWorkLink[]> =>
  [...((await rootOf(world)).thread?.githubWork ?? [])].sort(
    (left, right) => left.number - right.number,
  );

const deliver = async (
  world: World,
  event: string,
  body: unknown,
  deliveryId?: string,
): Promise<unknown> => {
  const signed = world.github.delivery(event, body, deliveryId);
  const response = await world.app.handle(
    new Request('https://purlay.test/api/webhooks/github-app', {
      method: 'POST',
      headers: signed.headers,
      body: signed.body,
    }),
  );
  expect(response.ok).toBe(true);
  return await response.json();
};

const where = { installation: { id: 31 }, repository: { id: API.id, full_name: API.fullName } };

const issueEvent = (
  action: string,
  number: number,
  over: { state?: 'open' | 'closed'; title?: string; updated?: string; body?: string } = {},
): Record<string, unknown> => ({
  action,
  ...where,
  issue: {
    number,
    title: over.title ?? 'Retry with jitter',
    body: over.body ?? '',
    state: over.state ?? 'open',
    updated_at: over.updated ?? at(0),
  },
});

const pullEvent = (
  action: string,
  number: number,
  over: { state?: 'open' | 'closed'; merged?: boolean | null; updated?: string } = {},
): Record<string, unknown> => ({
  action,
  ...where,
  number,
  pull_request: {
    title: 'Back off',
    state: over.state ?? 'open',
    merged: over.merged ?? false,
    updated_at: over.updated ?? at(0),
  },
});

const versionOf = async (db: Executor, world: World): Promise<number> =>
  (
    await db
      .selectFrom('messages')
      .select('state_version')
      .where('id', '=', world.rootId)
      .executeTakeFirstOrThrow()
  ).state_version;

describe('integration: linking work that exists (D-246 §3)', () => {
  test('links an issue as GitHub says it, read with the installation and never the person’s token', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const made = item(world, { title: 'Yeniden deneme 🙂', state: 'closed' });
      const linked = await link(world, 'https://github.com/acme/api/issues/1');
      expect(linked.status).toBe(201);
      expect(linked.json).toMatchObject({
        repository: 'acme/api',
        kind: 'issue',
        number: made.number,
        title: 'Yeniden deneme 🙂',
        state: 'closed',
        origin: 'linked',
        url: 'https://github.com/acme/api/issues/1',
      });
      expect(await workOf(world)).toHaveLength(1);
      // The thread's own work read the item as the installation: a person's token never fills a shared view.
      const reads = world.github.calls
        .map((call, index) => ({ call, by: world.github.callers[index] }))
        .filter(({ call }) => call.startsWith('GET /repos/acme/api/issues/'));
      expect(reads.map(({ by }) => by)).toEqual(['installation']);
      // On the trail by identifier alone, and nothing resolved or notified.
      const trail = await db
        .selectFrom('audit_log')
        .select(['actor_user_id', 'metadata'])
        .where('workspace_id', '=', world.workspaceId)
        .where('action', '=', 'integration.work_linked')
        .execute();
      expect(trail).toEqual([
        {
          actor_user_id: world.owner.userId,
          metadata: { repository: 'acme/api', number: '1', channelId: world.channelId },
        },
      ]);
      expect((await rootOf(world)).thread?.resolvedAt).toBeNull();
    });
  });

  test('the same item again is the same link, answered `200`; a pull request is a pull request, merged as GitHub says', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      item(world);
      const pull = item(world, { kind: 'pull', merged: true, state: 'closed', title: 'Back off' });
      const first = await link(world, 'https://github.com/acme/api/issues/1');
      const again = await link(world, 'https://github.com/acme/api/issues/1');
      expect([first.status, again.status]).toEqual([201, 200]);
      expect(again.json).toEqual(first.json);
      // The issues address of a pull request, and its pull address, are one item.
      const viaIssues = await link(
        world,
        `https://github.com/ACME/api/issues/${String(pull.number)}`,
      );
      expect(viaIssues.json).toMatchObject({ kind: 'pull', state: 'merged', title: 'Back off' });
      expect(
        (await link(world, `https://github.com/acme/api/pull/${String(pull.number)}`)).status,
      ).toBe(200);
      expect(await workOf(world)).toHaveLength(2);
    });
  });

  test('what does not exist and what may not be reached are one answer; nothing of a private repository is learnt', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      item(world);
      const missing = await link(world, 'https://github.com/acme/api/issues/999');
      const unlisted = await link(world, 'https://github.com/acme/secret/issues/1');
      world.github.installations.get(31)!.reachable = false;
      const unreachable = await link(world, 'https://github.com/acme/api/issues/1');
      expect([missing.status, unlisted.status, unreachable.status]).toEqual([400, 400, 400]);
      expect(unlisted.json).toEqual(missing.json);
      expect(unreachable.json).toEqual(missing.json);
      expect(await workOf(world)).toEqual([]);
    });
  });

  test('says what is wrong with the address, the person and the thread, before GitHub is asked about them', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      item(world);
      for (const url of [
        'https://gitlab.com/acme/api/issues/1',
        'https://github.com/acme/api/issues/abc',
        'https://github.com/acme/api/issues/1/extra',
        'http://github.com/acme/api/issues/1',
        'github.com/acme/api/issues/1',
        '',
      ]) {
        expect([url, (await link(world, url)).status]).toEqual([url, 400]);
      }
      const replyId = messageId(new Date(NOW.getTime() + 1000));
      const reply = await world.call(
        'POST',
        `/api/channels/${world.channelId}/messages`,
        world.owner,
        {
          id: replyId,
          content: 'A reply',
          parentId: world.rootId,
        },
      );
      expect(reply.status).toBe(201);
      expect(
        (await link(world, 'https://github.com/acme/api/issues/1', world.owner, replyId)).status,
      ).toBe(400);
      const outsider = await link(world, 'https://github.com/acme/api/issues/1', world.outsider);
      expect([outsider.status, codeOf(outsider.json)]).toEqual([403, 'NOT_A_CHANNEL_MEMBER']);
      const member = await link(world, 'https://github.com/acme/api/issues/1', world.member);
      expect([member.status, codeOf(member.json)]).toEqual([409, 'GITHUB_AUTHORIZATION_REQUIRED']);
    });
  });

  test('a thread of a private channel is not seen by those outside it, and needs an installation in use', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, { type: 'private' });
      item(world);
      const hidden = await link(world, 'https://github.com/acme/api/issues/1', world.outsider);
      expect([hidden.status, codeOf(hidden.json)]).toEqual([404, 'MESSAGE_NOT_FOUND']);
      await db
        .deleteFrom('github_app_installations')
        .where('workspace_id', '=', world.workspaceId)
        .execute();
      const none = await link(world, 'https://github.com/acme/api/issues/1');
      expect([none.status, codeOf(none.json)]).toEqual([409, 'GITHUB_NOT_CONNECTED']);
    });
  });

  test('a thread points at as much as twenty things, and the twenty-first is refused in words', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      for (let number = 1; number <= 21; number++) item(world);
      for (let number = 1; number <= 20; number++) {
        expect(
          (await link(world, `https://github.com/acme/api/issues/${String(number)}`)).status,
        ).toBe(201);
      }
      const over = await link(world, 'https://github.com/acme/api/issues/21');
      expect(over.status).toBe(400);
      expect(JSON.stringify(over.json)).toContain('already points at');
      expect(await workOf(world)).toHaveLength(20);
    });
  });

  test('a limit is a wait, GitHub not answering is 503, and a revoked authorization is asked for again', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      item(world);
      world.github.behaviour.limit = { times: 1, retryAfter: 21 };
      const response = await world.call(
        'POST',
        `/api/messages/${world.rootId}/github-link`,
        world.owner,
        {
          url: 'https://github.com/acme/api/issues/1',
        },
      );
      expect([response.status, response.headers.get('retry-after')]).toEqual([429, '21']);
      world.github.behaviour.unreachable = true;
      expect((await link(world, 'https://github.com/acme/api/issues/1')).status).toBe(503);
      world.github.behaviour.unreachable = false;
      world.github.revokeUser();
      const revoked = await link(world, 'https://github.com/acme/api/issues/1');
      expect([revoked.status, codeOf(revoked.json)]).toEqual([
        409,
        'GITHUB_AUTHORIZATION_REQUIRED',
      ]);
    });
  });
});

describe('integration: following linked work, from signed events (D-246 §3)', () => {
  const linked = async (world: World, ...made: Parameters<typeof item>[1][]): Promise<void> => {
    for (const over of made) {
      const created = item(world, over);
      const url = `https://github.com/acme/api/${created.kind === 'pull' ? 'pull' : 'issues'}/${String(created.number)}`;
      expect((await link(world, url)).status).toBe(201);
    }
  };

  test('closing, reopening and renaming an issue, and merging a pull request, show on the thread, and tell nobody', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await linked(world, {}, { kind: 'pull', title: 'Back off' });
      const before = await versionOf(db, world);
      expect(
        await deliver(
          world,
          'issues',
          issueEvent('closed', 1, { state: 'closed', updated: at(1) }),
        ),
      ).toEqual({
        outcome: 'applied',
      });
      expect((await workOf(world)).map((work) => [work.number, work.state])).toEqual([
        [1, 'closed'],
        [2, 'open'],
      ]);
      expect(await versionOf(db, world)).toBe(before + 1);
      await deliver(
        world,
        'issues',
        issueEvent('edited', 1, { state: 'closed', title: 'Yeniden: jitter 🙂', updated: at(2) }),
      );
      await deliver(
        world,
        'issues',
        issueEvent('reopened', 1, { title: 'Yeniden: jitter 🙂', updated: at(3) }),
      );
      expect((await workOf(world))[0]).toMatchObject({
        title: 'Yeniden: jitter 🙂',
        state: 'open',
      });
      await deliver(
        world,
        'pull_request',
        pullEvent('closed', 2, { state: 'closed', merged: true, updated: at(4) }),
      );
      expect((await workOf(world))[1]?.state).toBe('merged');
      await deliver(
        world,
        'pull_request',
        pullEvent('closed', 2, { state: 'closed', merged: null, updated: at(5) }),
      );
      // Closed, merged not known: closed — and the next word is its own.
      expect((await workOf(world))[1]?.state).toBe('closed');
      await deliver(world, 'pull_request', pullEvent('reopened', 2, { updated: at(6) }));
      expect((await workOf(world))[1]?.state).toBe('open');
      // Shown, never told as a notification, and the question is its own act.
      expect(
        await db
          .selectFrom('notifications')
          .select('id')
          .where('user_id', 'in', [world.owner.userId, world.member.userId])
          .execute(),
      ).toEqual([]);
      expect((await rootOf(world)).thread?.resolvedAt).toBeNull();
    });
  });

  test('a delivery out of order is dropped, a repeated one is nothing, and the same thing said again is not news', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await linked(world, {});
      await deliver(
        world,
        'issues',
        issueEvent('closed', 1, { state: 'closed', updated: at(10) }),
        'd-new',
      );
      // Older than what is shown: it cannot move the link back.
      await deliver(world, 'issues', issueEvent('reopened', 1, { state: 'open', updated: at(5) }));
      expect((await workOf(world))[0]?.state).toBe('closed');
      // The same delivery again, and the same signed body under an id made up.
      expect(
        await deliver(
          world,
          'issues',
          issueEvent('closed', 1, { state: 'closed', updated: at(10) }),
          'd-new',
        ),
      ).toEqual({ outcome: 'duplicate' });
      expect(
        await deliver(
          world,
          'issues',
          issueEvent('closed', 1, { state: 'closed', updated: at(10) }),
          'd-other',
        ),
      ).toEqual({ outcome: 'duplicate' });
      // Closed again, later: the instant moves and nothing the thread shows does — and nobody is told.
      const version = await versionOf(db, world);
      await deliver(world, 'issues', issueEvent('closed', 1, { state: 'closed', updated: at(20) }));
      expect(await versionOf(db, world)).toBe(version);
      // ...but it is the instant an older word is judged by, so an event between is dropped too.
      await deliver(world, 'issues', issueEvent('reopened', 1, { state: 'open', updated: at(15) }));
      expect((await workOf(world))[0]?.state).toBe('closed');
    });
  });

  test('only the workspaces of the installation the event came through are touched', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const other = await aWorld(db);
      await linked(world, {});
      // Another workspace, of another installation, that points at the same repository's issue.
      await db
        .updateTable('github_app_installations')
        .set({ installation_id: '32' })
        .where('workspace_id', '=', other.workspaceId)
        .execute();
      await db
        .insertInto('github_links')
        .values({
          id: crypto.randomUUID(),
          workspace_id: other.workspaceId,
          channel_id: other.channelId,
          root_id: other.rootId,
          repository_id: String(API.id),
          repository_full_name: API.fullName,
          kind: 'issue',
          number: 1,
          title: 'Retry with jitter',
          state: 'open',
          state_at: new Date(at(-30)),
          origin: 'linked',
          created_by: other.owner.userId,
          created_at: NOW,
        })
        .execute();
      await deliver(world, 'issues', issueEvent('closed', 1, { state: 'closed', updated: at(1) }));
      expect((await workOf(world))[0]?.state).toBe('closed');
      expect((await workOf(other))[0]?.state).toBe('open');
    });
  });

  test('events that change nothing a thread shows, and for what nobody linked, are received and applied to nothing', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await linked(world, {});
      const version = await versionOf(db, world);
      expect(await deliver(world, 'issues', issueEvent('labeled', 1, { updated: at(1) }))).toEqual({
        outcome: 'ignored',
      });
      expect(
        await deliver(
          world,
          'issues',
          issueEvent('closed', 77, { state: 'closed', updated: at(2) }),
        ),
      ).toEqual({
        outcome: 'applied',
      });
      // A pull request is told by its own event, not by the issue one GitHub also sends.
      expect(
        await deliver(world, 'issues', {
          ...issueEvent('closed', 1, { state: 'closed', updated: at(3) }),
          issue: { number: 1, title: 'x', state: 'closed', updated_at: at(3), pull_request: {} },
        }),
      ).toEqual({ outcome: 'ignored' });
      expect(await versionOf(db, world)).toBe(version);
      expect((await workOf(world))[0]?.state).toBe('open');
    });
  });

  test('a link outlives the installation: GitHub removing it leaves the work on the thread, followed no more', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await linked(world, {});
      await deliver(world, 'installation', { action: 'deleted', installation: { id: 31 } });
      expect(await workOf(world)).toHaveLength(1);
      await deliver(world, 'issues', issueEvent('closed', 1, { state: 'closed', updated: at(1) }));
      expect((await workOf(world))[0]?.state).toBe('open');
    });
  });

  test('an issue seen being opened with the marker of an answer that was lost is that operation, and nothing is posted twice', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, { deadlineMs: 100 });
      world.github.behaviour.create = 'creates-silently';
      const body = request();
      expect(outcomeOf((await create(world, body)).json).status).toBe('unknown');
      const made = world.github.items[0];
      if (made === undefined) throw new Error('GitHub made nothing');
      await deliver(
        world,
        'issues',
        issueEvent('opened', made.number, {
          title: made.title,
          body: made.body,
          updated: made.updatedAt,
        }),
      );
      const calls = world.github.calls.length;
      // Found by the delivery: asking again is the record's answer, with no look at GitHub and no post.
      const found = await create(world, body);
      expect([found.status, outcomeOf(found.json).status]).toEqual([201, 'created']);
      expect(world.github.calls).toHaveLength(calls);
      expect(world.github.items).toHaveLength(1);
      expect((await workOf(world))[0]).toMatchObject({ number: made.number, origin: 'created' });
      expect(made.body.endsWith(githubIssueMarker(body.clientRequestId))).toBe(true);
      expect(PERSON.login).toBe(made.creator);
    });
  });
});
