/**
 * Creating a GitHub issue from a thread over HTTP (D-246 §2, §4, `API.md` §7), against GitHub's strict
 * stand-in: the repositories a person may choose are the ones both they and the App reach; what is sent is the
 * person's reviewed words and one marker; everything is checked again as it is sent; one request id is one
 * issue — however many clicks — and a conflict when it names other content; a lost answer is found again by its
 * marker and never posted twice; a limit is a wait and a refused token is a request to authorize again.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import {
  cloneIntegrationDatabase,
  closeIntegrationDatabase,
  sql,
  withRollback,
  DROP_HOOK_MS,
  type ClonedDatabase,
} from '@purlay/db';
import { GitHubRepositoryList, githubIssueMarker, messageId } from '@purlay/types';
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
  WEB,
  type World,
} from '../../testing/github-world';

const clones: ClonedDatabase[] = [];
afterAll(async () => {
  for (const clone of clones) await clone.drop();
  await closeIntegrationDatabase();
}, DROP_HOOK_MS);

describe('integration: the repositories a person may choose (D-246 §2)', () => {
  test('are the ones both they and the App reach, as the contract says them', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const response = await world.call(
        'GET',
        `/api/workspaces/${world.workspaceId}/github-repositories`,
        world.owner,
      );
      expect(response.status).toBe(200);
      const listed: unknown = await response.json();
      if (!Value.Check(GitHubRepositoryList, listed)) throw new Error('not a list');
      expect(listed.repositories.map((repository) => repository.fullName)).toEqual([
        'acme/api',
        'acme/web',
      ]);
      // An installation the person cannot reach on GitHub offers them nothing.
      world.github.installations.get(31)!.reachable = false;
      const none = await world.call(
        'GET',
        `/api/workspaces/${world.workspaceId}/github-repositories`,
        world.owner,
      );
      expect(await none.json()).toEqual({ repositories: [] });
    });
  });

  test('need an installation in use, and the person’s own authorization, each said as itself', async () => {
    await withRollback(async (db) => {
      const path = (world: World): string =>
        `/api/workspaces/${world.workspaceId}/github-repositories`;
      const bare = await aWorld(db, { installed: false });
      expect(codeOf(await (await bare.call('GET', path(bare), bare.owner)).json())).toBe(
        'GITHUB_NOT_CONNECTED',
      );
      const unauthorised = await aWorld(db, { authorized: false });
      const refused = await unauthorised.call('GET', path(unauthorised), unauthorised.owner);
      expect([refused.status, codeOf(await refused.json())]).toEqual([
        409,
        'GITHUB_AUTHORIZATION_REQUIRED',
      ]);
      const suspended = await aWorld(db);
      await db
        .updateTable('github_app_installations')
        .set({ suspended_at: NOW })
        .where('workspace_id', '=', suspended.workspaceId)
        .execute();
      expect(
        codeOf(await (await suspended.call('GET', path(suspended), suspended.owner)).json()),
      ).toBe('GITHUB_NOT_CONNECTED');
    });
  });

  test('GitHub not answering is 503, and a limit is 429 with its Retry-After', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const path = `/api/workspaces/${world.workspaceId}/github-repositories`;
      world.github.behaviour.unreachable = true;
      const down = await world.call('GET', path, world.owner);
      expect([down.status, codeOf(await down.json())]).toEqual([503, 'GITHUB_UNAVAILABLE']);
      world.github.behaviour.unreachable = false;
      world.github.behaviour.limit = { times: 1, retryAfter: 37 };
      const limited = await world.call('GET', path, world.owner);
      expect([limited.status, limited.headers.get('retry-after')]).toEqual([429, '37']);
    });
  });
});

describe('integration: making an issue (D-246 §2)', () => {
  test('sends the reviewed words and the marker as the person, links the root, tells the thread and resolves nothing', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const before = await rootOf(world);
      const body = request({
        title: 'Yeniden deneme: jitter’lı 🙂',
        body: 'Karar: üstel, rastgelelikle.',
      });
      const made = await create(world, body);
      expect(made.status).toBe(201);
      const outcome = outcomeOf(made.json);
      if (outcome.status !== 'created') throw new Error('not created');
      expect(outcome.link).toMatchObject({
        repository: 'acme/api',
        kind: 'issue',
        number: 1,
        state: 'open',
        origin: 'created',
        url: 'https://github.com/acme/api/issues/1',
      });
      // What GitHub received: the words as reviewed, then the one line the review showed.
      const received = world.github.items[0];
      expect(received?.title).toBe(body.title);
      expect(received?.body).toBe(`${body.body}\n\n${githubIssueMarker(body.clientRequestId)}`);
      expect(received?.creator).toBe(PERSON.login);
      // The root says so, and nothing else about it moved.
      const after = await rootOf(world);
      expect(after.thread?.githubWork).toEqual([outcome.link]);
      expect(after.thread?.resolvedAt).toBeNull();
      expect(after.thread?.knowledge).toEqual(before.thread?.knowledge);
      expect(
        await db
          .selectFrom('notifications')
          .select('id')
          .where('user_id', 'in', [world.owner.userId, world.member.userId])
          .execute(),
      ).toEqual([]);
      // By identifier alone: who, where, which — never a word.
      const trail = await db
        .selectFrom('audit_log')
        .select(['action', 'actor_user_id', 'target_id', 'metadata'])
        .where('workspace_id', '=', world.workspaceId)
        .where('action', '=', 'integration.issue_created')
        .execute();
      expect(trail).toEqual([
        {
          action: 'integration.issue_created',
          actor_user_id: world.owner.userId,
          target_id: world.rootId,
          metadata: { repository: 'acme/api', issue: '1', channelId: world.channelId },
        },
      ]);
      expect(JSON.stringify(trail)).not.toContain('jitter');
    });
  });

  test('a request sent again is the same issue, answered as it was; other content under its id is a conflict', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const body = request();
      const first = await create(world, body);
      const again = await create(world, body);
      expect([first.status, again.status]).toEqual([201, 201]);
      expect(outcomeOf(again.json)).toEqual(outcomeOf(first.json));
      expect(world.github.items).toHaveLength(1);
      for (const other of [
        { title: 'Another title' },
        { body: 'Other words' },
        { repositoryId: WEB.id },
        { copyPrivateText: true },
      ]) {
        const conflict = await create(world, { ...body, ...other });
        expect([conflict.status, codeOf(conflict.json)]).toEqual([409, 'GITHUB_REQUEST_CONFLICT']);
      }
      expect(world.github.items).toHaveLength(1);
    });
  });

  test('somebody else’s request id is their own: the same id from another person is another request', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const body = request();
      await create(world, body);
      // The member has not authorized: their request is theirs, and says so, rather than finding the owner's.
      const theirs = await create(world, body, world.member);
      expect([theirs.status, codeOf(theirs.json)]).toEqual([409, 'GITHUB_AUTHORIZATION_REQUIRED']);
    });
  });

  test('a double click is one issue: the one that claimed it posts, and the other is told it is being made', async () => {
    // Two connections that see each other, so the two requests are really at the database at once.
    const clone = await cloneIntegrationDatabase();
    clones.push(clone);
    // The window between looking for the operation and claiming it, held open: both clicks are in it.
    await sql`
      create function hold_the_claim() returns trigger language plpgsql as
      $$ begin perform pg_sleep(0.3); return new; end $$
    `.execute(clone.db);
    await sql`
      create trigger hold_the_claim before insert on github_operations
      for each row execute function hold_the_claim()
    `.execute(clone.db);
    const world = await aWorld(clone.db);
    // GitHub is slow to answer, so the second click arrives while the first is still being heard.
    world.github.behaviour.create = 'slow';
    const body = request();
    const [one, two] = await Promise.all([create(world, body), create(world, body)]);
    expect(world.github.items).toHaveLength(1);
    expect([one.status, two.status].sort()).toEqual([201, 202]);
    expect([outcomeOf(one.json).status, outcomeOf(two.json).status].sort()).toEqual([
      'created',
      'pending',
    ]);
    expect(outcomeOf((await create(world, body)).json).status).toBe('created');
    expect(world.github.items).toHaveLength(1);
  });

  test('a lost answer is found by its marker when asked again, and nothing is posted twice', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, { deadlineMs: 100 });
      world.github.behaviour.create = 'creates-silently';
      const body = request();
      const lost = await create(world, body);
      expect([lost.status, outcomeOf(lost.json).status]).toEqual([202, 'unknown']);
      expect(world.github.items).toHaveLength(1);
      world.github.behaviour.create = 'creates';
      const found = await create(world, body);
      expect([found.status, outcomeOf(found.json).status]).toEqual([201, 'created']);
      expect(world.github.items).toHaveLength(1);
      expect((await rootOf(world)).thread?.githubWork).toHaveLength(1);
      // Asked a third time, it is the same, from the record.
      expect(outcomeOf((await create(world, body)).json).status).toBe('created');
      expect(world.github.items).toHaveLength(1);
    });
  });

  test('an answer lost with nothing made stays unknown, is looked for a bounded number of times, and ends as not created', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, { deadlineMs: 100 });
      world.github.behaviour.create = 'hangs';
      const body = request();
      expect(outcomeOf((await create(world, body)).json).status).toBe('unknown');
      expect(outcomeOf((await create(world, body)).json).status).toBe('unknown');
      const callsBefore = world.github.calls.filter((call) =>
        call.startsWith('POST /repos'),
      ).length;
      world.time.now = new Date(NOW.getTime() + 15 * 60_000);
      expect(outcomeOf((await create(world, body)).json)).toEqual({
        status: 'refused',
        reason: 'not-created',
      });
      // Looked for, never posted again; and what is refused stays refused.
      expect(world.github.calls.filter((call) => call.startsWith('POST /repos'))).toHaveLength(
        callsBefore,
      );
      expect(outcomeOf((await create(world, body)).json).status).toBe('refused');
      expect(world.github.items).toHaveLength(0);
    });
  });

  test('an operation claimed and never answered is taken as unknown after two minutes, and found', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const body = request();
      // A process that died after it claimed the operation and before GitHub answered: GitHub did make it.
      const body2 = `${body.body}\n\n${githubIssueMarker(body.clientRequestId)}`;
      world.github.items.push({
        id: 1,
        number: 1,
        kind: 'issue',
        repositoryId: API.id,
        title: body.title,
        body: body2,
        state: 'open',
        merged: false,
        creator: PERSON.login,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      });
      const { createHash } = await import('node:crypto');
      await db
        .insertInto('github_operations')
        .values({
          id: crypto.randomUUID(),
          workspace_id: world.workspaceId,
          actor_id: world.owner.userId,
          client_request_id: body.clientRequestId,
          content_digest: createHash('sha256')
            .update(
              JSON.stringify([body.repositoryId, body.title, body.body, body.copyPrivateText]),
            )
            .digest('hex'),
          root_id: world.rootId,
          repository_id: String(API.id),
          repository_full_name: API.fullName,
          marker: githubIssueMarker(body.clientRequestId),
          status: 'pending',
          created_at: NOW,
          updated_at: NOW,
        })
        .execute();
      expect(outcomeOf((await create(world, body)).json).status).toBe('pending');
      world.time.now = new Date(NOW.getTime() + 2 * 60_000);
      expect(outcomeOf((await create(world, body)).json).status).toBe('created');
      expect(world.github.items).toHaveLength(1);
    });
  });

  test('a limit is a wait for the client: 429 with Retry-After, the claim given back, and the same request goes through after', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const body = request();
      world.github.behaviour.limit = { times: 2, retryAfter: 45 };
      // The repositories are asked first, so the limit is met there; the next call is met at the create.
      const limited = await create(world, body);
      expect([limited.status, limited.headers.get('retry-after')]).toEqual([429, '45']);
      const again = await create(world, body);
      expect([again.status, again.headers.get('retry-after')]).toEqual([429, '45']);
      expect(
        await db
          .selectFrom('github_operations')
          .select('id')
          .where('workspace_id', '=', world.workspaceId)
          .execute(),
      ).toEqual([]);
      expect(outcomeOf((await create(world, body)).json).status).toBe('created');
      expect(world.github.items).toHaveLength(1);
    });
  });

  test('a token GitHub refuses is forgotten and asked for again; an expired one is refreshed once and goes on', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      world.github.expireUserTokens();
      world.time.now = new Date(NOW.getTime() + 9 * 3_600_000);
      expect(outcomeOf((await create(world, request())).json).status).toBe('created');
      // Refreshed: the next is a token GitHub took, and the old refresh token is spent.
      expect(outcomeOf((await create(world, request())).json).status).toBe('created');
      world.github.revokeUser();
      const refused = await create(world, request());
      expect([refused.status, codeOf(refused.json)]).toEqual([
        409,
        'GITHUB_AUTHORIZATION_REQUIRED',
      ]);
      expect(
        await db
          .selectFrom('github_user_authorizations')
          .select('id')
          .where('user_id', '=', world.owner.userId)
          .execute(),
      ).toEqual([]);
    });
  });

  test('GitHub refusing the repository is said, not made: no access now is a refusal, and nothing is claimed', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const unlisted = await create(world, request({ repositoryId: 9999 }));
      expect([unlisted.status, outcomeOf(unlisted.json)]).toEqual([
        200,
        { status: 'refused', reason: 'no-access' },
      ]);
      expect(world.github.items).toHaveLength(0);
    });
  });
});

describe('integration: who may make it, checked as it is sent (D-246 §2)', () => {
  test('a person who cannot read the root is told it is not there, in the words of any message that is not', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, { type: 'private' });
      const hidden = await create(world, request(), world.outsider);
      const absent = await create(
        world,
        request(),
        world.outsider,
        '00000000-0000-4000-8000-000000000000',
      );
      expect([hidden.status, hidden.json]).toEqual(
        [404, absent.json].length ? [absent.status, absent.json] : [],
      );
      expect(codeOf(hidden.json)).toBe('MESSAGE_NOT_FOUND');
    });
  });

  test('a member of the workspace who is not in a public channel is asked to join first, and makes nothing', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const refused = await create(world, request(), world.outsider);
      expect([refused.status, codeOf(refused.json)]).toEqual([403, 'NOT_A_CHANNEL_MEMBER']);
      expect(world.github.items).toHaveLength(0);
    });
  });

  test('a person removed from the channel after opening the form is refused when they send it', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      await db
        .deleteFrom('channel_members')
        .where('channel_id', '=', world.channelId)
        .where('user_id', '=', world.owner.userId)
        .execute();
      const refused = await create(world, request());
      expect(refused.status).toBe(403);
      expect(world.github.items).toHaveLength(0);
    });
  });

  test('the words of a conversation that is not public are copied only when the person said so', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, { type: 'private' });
      const silent = await create(world, request());
      expect(silent.status).toBe(400);
      expect(silent.json).toMatchObject({
        error: {
          code: 'VALIDATION_FAILED',
          details: {
            fields: {
              copyPrivateText: 'Say that the words of this conversation may be copied to GitHub.',
            },
          },
        },
      });
      expect(world.github.items).toHaveLength(0);
      expect(outcomeOf((await create(world, request({ copyPrivateText: true }))).json).status).toBe(
        'created',
      );
    });
  });

  test('only the message that started a thread can become an issue', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const replyId = messageId(new Date(NOW.getTime() + 1));
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
      const refused = await create(world, request(), world.owner, replyId);
      expect([refused.status, codeOf(refused.json)]).toEqual([400, 'VALIDATION_FAILED']);
    });
  });

  test('a suspended installation, or one GitHub removed, makes nothing; the person losing the repository on GitHub is a refusal', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      world.github.installations.get(31)!.reachable = false;
      expect(outcomeOf((await create(world, request())).json)).toEqual({
        status: 'refused',
        reason: 'no-access',
      });
      world.github.installations.get(31)!.reachable = true;
      await db
        .updateTable('github_app_installations')
        .set({ suspended_at: NOW })
        .where('workspace_id', '=', world.workspaceId)
        .execute();
      const suspended = await create(world, request());
      expect([suspended.status, codeOf(suspended.json)]).toEqual([409, 'GITHUB_NOT_CONNECTED']);
      await db
        .deleteFrom('github_app_installations')
        .where('workspace_id', '=', world.workspaceId)
        .execute();
      expect(codeOf((await create(world, request())).json)).toBe('GITHUB_NOT_CONNECTED');
      expect(world.github.items).toHaveLength(0);
    });
  });

  test('a link outlives the installation: GitHub removing it leaves what was made on the root', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      expect(outcomeOf((await create(world, request())).json).status).toBe('created');
      await db
        .deleteFrom('github_app_installations')
        .where('workspace_id', '=', world.workspaceId)
        .execute();
      expect((await rootOf(world)).thread?.githubWork).toHaveLength(1);
    });
  });

  test('a signed-out caller is 401; a body that is not the contract, or too long, is 400 and sends nothing', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const signedOut = await world.call(
        'POST',
        `/api/messages/${world.rootId}/github-issue`,
        {
          userId: '',
          cookie: '',
        },
        request(),
      );
      expect(signedOut.status).toBe(401);
      for (const over of [
        { title: '' },
        { title: 'x'.repeat(257) },
        { body: 'x'.repeat(60_001) },
        { clientRequestId: 'not-an-id' },
        { repositoryId: 0 },
        { extra: true },
      ]) {
        const refused = await create(world, { ...request(), ...over });
        expect([JSON.stringify(over).slice(0, 30), refused.status]).toEqual([
          JSON.stringify(over).slice(0, 30),
          400,
        ]);
      }
      expect(world.github.items).toHaveLength(0);
      // The limits themselves are accepted.
      expect(
        outcomeOf((await create(world, request({ title: 'x'.repeat(256), body: '' }))).json).status,
      ).toBe('created');
    });
  });
});

describe('integration: the paths a bad day takes (D-246 §4)', () => {
  test('a refresh token GitHub refuses ends the authorization, and the person is asked for it again', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      world.github.expireUserTokens();
      world.time.now = new Date(NOW.getTime() + 9 * 3_600_000);
      // Revoked on GitHub: the refresh token is spent with it.
      world.github.revokeUser();
      const refused = await create(world, request());
      expect([refused.status, codeOf(refused.json)]).toEqual([
        409,
        'GITHUB_AUTHORIZATION_REQUIRED',
      ]);
      expect(
        await db
          .selectFrom('github_user_authorizations')
          .select('id')
          .where('user_id', '=', world.owner.userId)
          .execute(),
      ).toEqual([]);
    });
  });

  test('a limit met at the create itself gives the claim back, with its wait, and the same request goes through', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const body = request();
      world.github.behaviour.create = 'limits';
      const limited = await create(world, body);
      expect([limited.status, limited.headers.get('retry-after')]).toEqual([429, '30']);
      expect(
        await db
          .selectFrom('github_operations')
          .select('id')
          .where('workspace_id', '=', world.workspaceId)
          .execute(),
      ).toEqual([]);
      world.github.behaviour.create = 'creates';
      expect(outcomeOf((await create(world, body)).json).status).toBe('created');
      expect(world.github.items).toHaveLength(1);
    });
  });

  test('GitHub unreachable while looking for a lost answer is still not known, and is not a look', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, { deadlineMs: 100 });
      world.github.behaviour.create = 'creates-silently';
      const body = request();
      expect(outcomeOf((await create(world, body)).json).status).toBe('unknown');
      world.github.behaviour.create = 'creates';
      world.github.behaviour.unreachable = true;
      expect(outcomeOf((await create(world, body)).json).status).toBe('unknown');
      const row = await db
        .selectFrom('github_operations')
        .select('attempts')
        .where('workspace_id', '=', world.workspaceId)
        .executeTakeFirstOrThrow();
      expect(row.attempts).toBe(0);
    });
  });

  test('the App’s own token refused is GitHub unavailable, and the person’s authorization stays', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db, { deadlineMs: 100 });
      world.github.behaviour.create = 'creates-silently';
      const body = request();
      expect(outcomeOf((await create(world, body)).json).status).toBe('unknown');
      world.github.behaviour.appTokenRefused = true;
      // Looking for the lost answer: not known yet, which is the truth.
      expect(outcomeOf((await create(world, body)).json).status).toBe('unknown');
      // Reading linked work as the installation: GitHub not answering, never the person's fault.
      const linked = await world.call(
        'POST',
        `/api/messages/${world.rootId}/github-link`,
        world.owner,
        {
          url: 'https://github.com/acme/api/issues/1',
        },
      );
      expect([linked.status, codeOf(await linked.json())]).toEqual([503, 'GITHUB_UNAVAILABLE']);
      expect(
        await db
          .selectFrom('github_user_authorizations')
          .select('id')
          .where('user_id', '=', world.owner.userId)
          .execute(),
      ).toHaveLength(1);
    });
  });

  test('a refused operation holding a reason the contract does not name is a defect, said loudly', async () => {
    await withRollback(async (db) => {
      const world = await aWorld(db);
      const body = request();
      await create(world, body);
      await db
        .updateTable('github_operations')
        .set({ status: 'refused', reason: 'made-up', issue_number: null })
        .where('workspace_id', '=', world.workspaceId)
        .execute();
      expect((await create(world, body)).status).toBe(500);
    });
  });
});
