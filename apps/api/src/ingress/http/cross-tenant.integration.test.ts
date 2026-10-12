/**
 * Every case in `CROSS_TENANT`, crossed for real.
 *
 * The stranger is a member of a workspace of their own, so this is a crossing
 * between two tenants rather than a request from nobody. Each crossing asserts
 * four things:
 *
 * 1. the stranger gets `404` with the case's code — never `403`, which would
 *    confirm the resource exists (D-21);
 * 2. that answer is byte-for-byte the one for an id that never existed, so the
 *    two cannot be told apart;
 * 3. so is the answer for an id that is not a UUID at all, which PostgreSQL would
 *    otherwise refuse with a cast error and the boundary answer `500` (§7.3);
 * 4. the owner's identical request succeeds. Without this, a path that routes
 *    nowhere would pass every assertion above — its `404` is just as real.
 *
 * Which endpoints must appear here is not decided in this file
 * (`cross-tenant.test.ts`, D-63).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { closeIntegrationDatabase, withRollback, type Executor } from '@purlay/db';
import { messageId } from '@purlay/types';
import { createApp } from './app';
import { CROSS_TENANT, pathFor, queryFor, type Ids, requestInit } from '../../testing/cross-tenant';
import { NOW, testDependencies } from '../../testing/doubles';
import { fixedClock } from '../../platform/clock';
import { aSignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';
import { twoColourPng } from '../../testing/png';
import { aMemoryStore } from '../../testing/storage';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const clock = fixedClock(NOW);

/** One store for the file, so what an owner uploads is there when they read it back. */
const STORE = aMemoryStore();

const call = async (
  db: Executor,
  method: string,
  path: string,
  cookie: string,
  body?: unknown,
): Promise<Response> =>
  await createApp(testDependencies({ database: db, clock, storage: STORE })).handle(
    new Request(`https://purlay.test${path}`, requestInit(method, cookie, body)),
  );

const signedIn = async (db: Executor, name: string): Promise<string> =>
  (await aSignedInUser(db, clock, name)).cookie;

const created = async (response: Response): Promise<string> => {
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
};

/** A workspace with a channel, and a thread in it, owned by whoever `cookie` belongs to. */
const aTenant = async (db: Executor, cookie: string, slug: string): Promise<Ids> => {
  const workspaceId = await created(
    await call(db, 'POST', '/api/workspaces', cookie, { name: slug, slug: aUniqueSlug(slug) }),
  );
  const channelId = await created(
    await call(db, 'POST', `/api/workspaces/${workspaceId}/channels`, cookie, { name: 'general' }),
  );
  // A root with one reply, so every message endpoint the owner crosses has something to
  // succeed on: a thread to read, one that can be resolved, one that can be reopened.
  // An image the root carries, and an upload not sent yet: every attachment endpoint has one to
  // succeed on.
  const uploadOne = async (): Promise<string> => {
    const id = messageId(new Date(NOW.getTime() - 1_000));
    await created(
      await call(
        db,
        'POST',
        `/api/workspaces/${workspaceId}/uploads?id=${id}&name=crossing.png`,
        cookie,
        twoColourPng(32, 32),
      ),
    );
    return id;
  };
  const attachmentId = await uploadOne();
  const unsentAttachmentId = await uploadOne();
  const root = messageId(NOW);
  await created(
    await call(db, 'POST', `/api/channels/${channelId}/messages`, cookie, {
      id: root,
      content: 'a question',
      attachmentIds: [attachmentId],
    }),
  );
  await created(
    await call(db, 'POST', `/api/channels/${channelId}/messages`, cookie, {
      id: messageId(NOW),
      content: 'an answer',
      parentId: root,
    }),
  );
  // Somebody the owner can make an admin, or remove.
  const member = await aSignedInUser(db, clock, `${slug}-member`);
  await db
    .insertInto('workspace_members')
    .values({ workspace_id: workspaceId, user_id: member.userId, role: 'member', joined_at: NOW })
    .execute();
  // A link to revoke.
  const invitation = await call(db, 'POST', `/api/workspaces/${workspaceId}/invitations`, cookie);
  expect(invitation.status).toBe(201);
  const { invitation: made } = (await invitation.json()) as { invitation: { id: string } };
  return {
    workspaceId,
    channelId,
    messageId: root,
    attachmentId,
    unsentAttachmentId,
    memberId: member.userId,
    invitationId: made.id,
  };
};

const NEVER_EXISTED: Ids = {
  workspaceId: '00000000-0000-4000-8000-000000000000',
  channelId: '00000000-0000-4000-8000-000000000000',
  messageId: '00000000-0000-4000-8000-000000000000',
  attachmentId: '00000000-0000-4000-8000-000000000000',
  unsentAttachmentId: '00000000-0000-4000-8000-000000000000',
  memberId: '00000000-0000-4000-8000-000000000000',
  invitationId: '00000000-0000-4000-8000-000000000000',
};

const NOT_A_UUID: Ids = {
  workspaceId: 'not-a-uuid',
  channelId: 'not-a-uuid',
  messageId: 'not-a-uuid',
  attachmentId: 'not-a-uuid',
  unsentAttachmentId: 'not-a-uuid',
  memberId: 'not-a-uuid',
  invitationId: 'not-a-uuid',
};

describe('integration: cross-tenant isolation', () => {
  for (const [key, crossing] of Object.entries(CROSS_TENANT)) {
    const [method = '', path = ''] = key.split(' ');

    // A discard names an upload nobody has sent; everything else, the one the root carries.
    const aimed = (ids: Ids): Ids =>
      crossing.unsent === true ? { ...ids, attachmentId: ids.unsentAttachmentId } : ids;

    test(`${key} answers 404 across a tenant boundary, as if it did not exist`, async () => {
      await withRollback(async (db) => {
        const ownerUser = await aSignedInUser(db, clock, 'xt-owner');
        const owner = ownerUser.cookie;
        const stranger = await signedIn(db, 'xt-stranger');
        const theirs = await aTenant(db, owner, 'xt-theirs');
        await aTenant(db, stranger, 'xt-own');
        const body = crossing.body?.(NOW, {
          userId: ownerUser.userId,
          workspaceId: theirs.workspaceId,
          messageId: theirs.messageId,
        });

        const across = await call(
          db,
          method,
          pathFor(`${path}${queryFor(crossing)}`, aimed(theirs)),
          stranger,
          body,
        );
        expect(across.status).toBe(404);
        const refusal: unknown = await across.json();
        expect(refusal).toMatchObject({ error: { code: crossing.refusal } });

        for (const ids of [NEVER_EXISTED, NOT_A_UUID]) {
          const elsewhere = await call(
            db,
            method,
            pathFor(`${path}${queryFor(crossing)}`, aimed(ids)),
            stranger,
            body,
          );
          expect({ status: elsewhere.status, body: await elsewhere.json() }).toEqual({
            status: 404,
            body: refusal,
          });
        }

        const own = await call(
          db,
          method,
          pathFor(`${path}${queryFor(crossing)}`, aimed(theirs)),
          owner,
          body,
        );
        expect({ status: own.status, ok: own.ok }).toEqual({ status: own.status, ok: true });
      });
    });
  }
});
