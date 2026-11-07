/**
 * Issues' source of the workspace-wide find (D-285), read straight from the module: a title or a body that holds the words,
 * folded as chat's search folds them, in the caller's workspace and no other, newest first, each issue once, cut to the limit.
 * The door and the fan-out are `ingress/http/find.integration.test.ts` and `modules/find/find.integration.test.ts`.
 *
 * @needs-modules issues
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId } from '@purlay/types';
import { requireWorkspaceMembership } from '../../platform/tenancy';
import { NOW } from '../../testing/doubles';
import { aRoom } from '../../testing/rooms';
import { issuesSearchSource } from './search';

afterAll(async () => {
  await closeIntegrationDatabase();
});

let tick = 0;
const anIssue = async (
  db: Executor,
  workspaceId: string,
  title: string,
  body = '',
): Promise<string> => {
  tick += 1;
  const id = messageId(new Date(NOW.getTime() + tick * 1_000));
  await db.insertInto('issues').values({ id, workspace_id: workspaceId, title, body }).execute();
  return id;
};

const aWorkspace = async (db: Executor): Promise<{ workspaceId: string; userId: string }> => {
  const room = await aRoom(db, ['alice']);
  return { workspaceId: room.workspaceId, userId: room.members['alice']?.userId ?? '' };
};

const found = async (
  db: Executor,
  world: { workspaceId: string; userId: string },
  query: string,
  limit = 10,
): Promise<string[]> => {
  const context = await requireWorkspaceMembership(db, world.userId, world.workspaceId);
  const hits = await issuesSearchSource.search({ database: db, context, query, limit });
  return hits.map((hit) => hit.id);
};

describe('integration: issues’ search source', () => {
  test('finds a title and a body, each issue once, newest first', async () => {
    await withRollback(async (db) => {
      const world = await aWorkspace(db);
      const byTitle = await anIssue(db, world.workspaceId, 'Rotate the deploy key');
      const byBody = await anIssue(db, world.workspaceId, 'Keys', 'before the DEPLOY on friday');
      const byBoth = await anIssue(db, world.workspaceId, 'Deploy', 'the deploy script');
      await anIssue(db, world.workspaceId, 'Unrelated', 'nothing here');
      expect(await found(db, world, 'deploy')).toEqual([byBoth, byBody, byTitle]);
    });
  });

  test('says what it found as a hit: the title, the body’s first line, the time and the issue', async () => {
    await withRollback(async (db) => {
      const world = await aWorkspace(db);
      const id = await anIssue(db, world.workspaceId, 'Deploy', '\nthe script\nand more');
      const empty = await anIssue(db, world.workspaceId, 'Deploy again');
      const context = await requireWorkspaceMembership(db, world.userId, world.workspaceId);
      const hits = await issuesSearchSource.search({
        database: db,
        context,
        query: 'deploy',
        limit: 10,
      });
      expect(hits.map((hit) => [hit.id, hit.title, hit.excerpt, hit.target])).toEqual([
        [empty, 'Deploy again', null, { type: 'issue', issueId: empty }],
        [id, 'Deploy', 'the script', { type: 'issue', issueId: id }],
      ]);
    });
  });

  test('folds case as the search does, so İstanbul is found by istanbul', async () => {
    await withRollback(async (db) => {
      const world = await aWorkspace(db);
      const id = await anIssue(db, world.workspaceId, 'İstanbul office');
      expect(await found(db, world, 'istanbul')).toEqual([id]);
      expect(await found(db, world, 'ISTANBUL')).toEqual([id]);
    });
  });

  test('takes % and _ as themselves, not as patterns', async () => {
    await withRollback(async (db) => {
      const world = await aWorkspace(db);
      const id = await anIssue(db, world.workspaceId, 'Raise 100% coverage');
      await anIssue(db, world.workspaceId, 'Raise 1000 coverage');
      expect(await found(db, world, '100%')).toEqual([id]);
      expect(await found(db, world, '1_0')).toEqual([]);
    });
  });

  test('is cut to the limit, keeping the newest', async () => {
    await withRollback(async (db) => {
      const world = await aWorkspace(db);
      await anIssue(db, world.workspaceId, 'deploy one');
      const second = await anIssue(db, world.workspaceId, 'deploy two');
      const third = await anIssue(db, world.workspaceId, 'deploy three');
      expect(await found(db, world, 'deploy', 2)).toEqual([third, second]);
    });
  });

  test('never finds another workspace’s issue, with the same words in both', async () => {
    await withRollback(async (db) => {
      const mine = await aWorkspace(db);
      const theirs = await aWorkspace(db);
      const own = await anIssue(db, mine.workspaceId, 'our deploy');
      await anIssue(db, theirs.workspaceId, 'their deploy', 'deploy deploy');
      expect(await found(db, mine, 'deploy')).toEqual([own]);
    });
  });
});
