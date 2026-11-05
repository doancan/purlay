/**
 * Issues over HTTP, on a real database (D-254): who may make, change and delete, the list's pages, what a stranger
 * and another workspace see (nothing), and what an erased account leaves.
 *
 * @needs-modules issues
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { Value } from '@sinclair/typebox/value';
import { closeIntegrationDatabase, sql, withRollback, type Executor } from '@purlay/db';
import {
  ISSUES_PER_WORKSPACE_MAX,
  ISSUE_BODY_MAX,
  ISSUE_TITLE_MAX,
  Issue,
  IssuePage,
  type UserRole,
} from '@purlay/types';
import { composition } from '../../composition';
import { fixedClock } from '../../platform/clock';
import { NOW, testDependencies } from '../../testing/doubles';
import { aSignedInUser, type SignedInUser } from '../../testing/signed-in';
import { aUniqueSlug } from '../../testing/users';
import { createApp } from './app';

afterAll(async () => {
  await closeIntegrationDatabase();
});

const ORIGIN = 'https://purlay.test';
let tick = 0;
/** Each call a little later than the last, so ids made on one clock still sort in the order they were made. */
const nextClock = (): ReturnType<typeof fixedClock> =>
  fixedClock(new Date(NOW.getTime() + (tick += 5)));

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

const caller = (db: Executor) => {
  return async (
    method: string,
    path: string,
    who: SignedInUser | null,
    body?: unknown,
  ): Promise<Answer> => {
    const app = createApp(testDependencies({ database: db, clock: nextClock(), composition }));
    const headers: Record<string, string> = who === null ? {} : { cookie: who.cookie };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const response = await app.handle(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const text = await response.text();
    return { status: response.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
  };
};

const code = (answer: Answer): unknown =>
  (answer.body as { error?: { code?: string } }).error?.code;

interface Workspace {
  readonly id: string;
  readonly path: string;
  readonly people: Readonly<Record<string, SignedInUser>>;
}

/** A workspace whose members have the roles given, the first of them in it as the owner would be. */
const aWorkspace = async (
  db: Executor,
  roles: Readonly<Record<string, UserRole>>,
): Promise<Workspace> => {
  const workspace = await db
    .insertInto('workspaces')
    .values({ name: 'Issues', slug: aUniqueSlug('iss') })
    .returning('id')
    .executeTakeFirstOrThrow();
  const people: Record<string, SignedInUser> = {};
  for (const [name, role] of Object.entries(roles)) {
    const person = await aSignedInUser(db, nextClock(), name);
    people[name] = person;
    await db
      .insertInto('workspace_members')
      .values({ workspace_id: workspace.id, user_id: person.userId, role })
      .execute();
  }
  return { id: workspace.id, path: `/api/workspaces/${workspace.id}/issues`, people };
};

const person = (workspace: Workspace, name: string): SignedInUser => {
  const found = workspace.people[name];
  if (found === undefined) throw new Error(`no ${name}`);
  return found;
};

describe('integration: issues over HTTP', () => {
  test('a member makes an issue: open, theirs, with an empty body and nobody assigned unless asked', async () => {
    await withRollback(async (db) => {
      const call = caller(db);
      const w = await aWorkspace(db, { ada: 'owner', bob: 'member' });
      const bob = person(w, 'bob');
      const made = await call('POST', w.path, bob, { title: '  Fix the build  ' });
      expect(made.status).toBe(201);
      expect(Value.Check(Issue, made.body)).toBe(true);
      expect(made.body).toMatchObject({
        title: 'Fix the build',
        body: '',
        status: 'open',
        assigneeId: null,
        createdBy: bob.userId,
      });
      const assigned = await call('POST', w.path, bob, {
        title: 'Ship it',
        body: '# Plan\n\n- one',
        assigneeId: person(w, 'ada').userId,
      });
      expect(assigned.body).toMatchObject({
        body: '# Plan\n\n- one',
        assigneeId: person(w, 'ada').userId,
      });
      const row = await db
        .selectFrom('issues')
        .select(['workspace_id', 'created_by', 'title'])
        .where('id', '=', (made.body as Issue).id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ workspace_id: w.id, created_by: bob.userId, title: 'Fix the build' });
    });
  });

  test('refuses what the contract refuses, naming the field and writing nothing', async () => {
    await withRollback(async (db) => {
      const call = caller(db);
      const w = await aWorkspace(db, { ada: 'owner', bob: 'member' });
      const ada = person(w, 'ada');
      const outsider = await aSignedInUser(db, nextClock(), 'outsider');
      const bad: readonly [string, unknown][] = [
        ['title', { title: '' }],
        ['title', { title: '   ' }],
        ['title', { title: 'x'.repeat(ISSUE_TITLE_MAX + 1) }],
        ['body', { title: 'x', body: 'y'.repeat(ISSUE_BODY_MAX + 1) }],
        ['status', { title: 'x', status: 'done' }],
        ['title', {}],
        ['assigneeId', { title: 'x', assigneeId: 'not-a-uuid' }],
        // Somebody who is not in this workspace: any account, or one that does not exist.
        ['assigneeId', { title: 'x', assigneeId: outsider.userId }],
        ['assigneeId', { title: 'x', assigneeId: '00000000-0000-7000-8000-000000000000' }],
      ];
      for (const [field, body] of bad) {
        const answer = await call('POST', w.path, ada, body);
        expect({ body, status: answer.status, code: code(answer) }).toEqual({
          body,
          status: 400,
          code: 'VALIDATION_FAILED',
        });
        expect(JSON.stringify(answer.body)).toContain(field);
      }
      // The longest title and body the contract allows are kept whole, in characters.
      const longest = await call('POST', w.path, ada, {
        title: 'ğ'.repeat(ISSUE_TITLE_MAX),
        body: 'ü'.repeat(ISSUE_BODY_MAX),
      });
      expect(longest.status).toBe(201);
      expect((longest.body as Issue).title).toHaveLength(ISSUE_TITLE_MAX);
      const count = await db
        .selectFrom('issues')
        .select('id')
        .where('workspace_id', '=', w.id)
        .execute();
      expect(count).toHaveLength(1);
    });
  });

  test('asks for a session, and a stranger to the workspace finds nothing, on every route', async () => {
    await withRollback(async (db) => {
      const call = caller(db);
      const w = await aWorkspace(db, { ada: 'owner' });
      const made = await call('POST', w.path, person(w, 'ada'), { title: 'Private' });
      const issue = made.body as Issue;
      const stranger = await aSignedInUser(db, nextClock(), 'stranger');
      const routes: readonly (readonly [string, string, unknown?])[] = [
        ['GET', w.path],
        ['POST', w.path, { title: 'x' }],
        ['PATCH', `${w.path}/${issue.id}`, { status: 'done' }],
        ['DELETE', `${w.path}/${issue.id}`],
      ];
      for (const [method, path, body] of routes) {
        expect((await call(method, path, null, body)).status).toBe(401);
        const answer = await call(method, path, stranger, body);
        expect({ method, status: answer.status, code: code(answer) }).toEqual({
          method,
          status: 404,
          code: 'WORKSPACE_NOT_FOUND',
        });
      }
      const row = await db
        .selectFrom('issues')
        .select(['title', 'status'])
        .where('id', '=', issue.id)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ title: 'Private', status: 'open' });
    });
  });

  test('an issue of another workspace is not found through this one, for a member of both', async () => {
    await withRollback(async (db) => {
      const call = caller(db);
      const a = await aWorkspace(db, { ada: 'owner' });
      const b = await aWorkspace(db, { ada2: 'owner' });
      const theirs = (await call('POST', b.path, person(b, 'ada2'), { title: 'Theirs' }))
        .body as Issue;
      // ada belongs to both.
      await db
        .insertInto('workspace_members')
        .values({ workspace_id: b.id, user_id: person(a, 'ada').userId, role: 'owner' })
        .execute();
      const ada = person(a, 'ada');
      expect(((await call('GET', a.path, ada)).body as IssuePage).data).toEqual([]);
      for (const [method, body] of [
        ['PATCH', { title: 'Hijacked' }],
        ['DELETE', undefined],
      ] as const) {
        const answer = await call(method, `${a.path}/${theirs.id}`, ada, body);
        expect({ method, status: answer.status, code: code(answer) }).toEqual({
          method,
          status: 404,
          code: 'ISSUE_NOT_FOUND',
        });
      }
      for (const id of ['not-a-uuid', '00000000-0000-7000-8000-000000000000']) {
        expect(code(await call('PATCH', `${a.path}/${id}`, ada, { title: 'x' }))).toBe(
          'ISSUE_NOT_FOUND',
        );
        expect(code(await call('DELETE', `${a.path}/${id}`, ada))).toBe('ISSUE_NOT_FOUND');
      }
      const kept = await db
        .selectFrom('issues')
        .select('title')
        .where('id', '=', theirs.id)
        .executeTakeFirstOrThrow();
      expect(kept.title).toBe('Theirs');
    });
  });

  test('the list is newest first, in pages that continue where the last stopped, and can be narrowed to a status', async () => {
    await withRollback(async (db) => {
      const call = caller(db);
      const w = await aWorkspace(db, { ada: 'owner' });
      const ada = person(w, 'ada');
      const made: Issue[] = [];
      for (const title of ['one', 'two', 'three', 'four', 'five']) {
        made.push((await call('POST', w.path, ada, { title })).body as Issue);
      }
      for (const done of [made[1], made[3]]) {
        await call('PATCH', `${w.path}/${done?.id ?? ''}`, ada, { status: 'done' });
      }
      const cursorOf = (answer: Answer): string => (answer.body as IssuePage).nextCursor ?? '';

      const titles = (answer: Answer): string[] =>
        (answer.body as IssuePage).data.map((issue) => issue.title);
      const first = await call('GET', `${w.path}?limit=2`, ada);
      expect(Value.Check(IssuePage, first.body)).toBe(true);
      expect(titles(first)).toEqual(['five', 'four']);
      const second = await call('GET', `${w.path}?limit=2&before=${cursorOf(first)}`, ada);
      expect(titles(second)).toEqual(['three', 'two']);
      const last = await call('GET', `${w.path}?limit=2&before=${cursorOf(second)}`, ada);
      expect(titles(last)).toEqual(['one']);
      expect((last.body as IssuePage).nextCursor).toBeNull();
      // A page that ends exactly at the end has no next page.
      expect((await call('GET', `${w.path}?limit=5`, ada)).body).toMatchObject({
        nextCursor: null,
      });

      expect(titles(await call('GET', `${w.path}?status=done`, ada))).toEqual(['four', 'two']);
      expect(titles(await call('GET', `${w.path}?status=open`, ada))).toEqual([
        'five',
        'three',
        'one',
      ]);
      for (const query of ['status=closed', 'limit=0', 'limit=101', 'before=x', 'sort=title']) {
        expect({ query, status: (await call('GET', `${w.path}?${query}`, ada)).status }).toEqual({
          query,
          status: 400,
        });
      }
    });
  });

  test('any member changes any issue: title, body, status, assignee, and clears the assignee with null', async () => {
    await withRollback(async (db) => {
      const call = caller(db);
      const w = await aWorkspace(db, { ada: 'owner', bob: 'member', cy: 'member' });
      const [ada, bob, cy] = ['ada', 'bob', 'cy'].map((name) => person(w, name));
      if (ada === undefined || bob === undefined || cy === undefined) throw new Error('missing');
      const made = (await call('POST', w.path, ada, { title: 'Old', body: 'old' })).body as Issue;
      const path = `${w.path}/${made.id}`;

      const edited = await call('PATCH', path, bob, {
        title: ' New ',
        body: 'new **body**',
        status: 'done',
        assigneeId: cy.userId,
      });
      expect(edited.status).toBe(200);
      expect(Value.Check(Issue, edited.body)).toBe(true);
      expect(edited.body).toMatchObject({
        id: made.id,
        title: 'New',
        body: 'new **body**',
        status: 'done',
        assigneeId: cy.userId,
        // Who made it does not change with who edits it.
        createdBy: ada.userId,
        createdAt: made.createdAt,
      });
      expect(new Date((edited.body as Issue).updatedAt).getTime()).toBeGreaterThan(
        new Date(made.updatedAt).getTime(),
      );
      // One field alone leaves the rest.
      const reopened = await call('PATCH', path, cy, { status: 'open' });
      expect(reopened.body).toMatchObject({ status: 'open', title: 'New', assigneeId: cy.userId });
      const cleared = await call('PATCH', path, cy, { assigneeId: null });
      expect(cleared.body).toMatchObject({ assigneeId: null, status: 'open' });
    });
  });

  test('refuses an empty change, a field it does not know, a blank title and an assignee from outside', async () => {
    await withRollback(async (db) => {
      const call = caller(db);
      const w = await aWorkspace(db, { ada: 'owner' });
      const ada = person(w, 'ada');
      const outsider = await aSignedInUser(db, nextClock(), 'outsider');
      const made = (await call('POST', w.path, ada, { title: 'Keep' })).body as Issue;
      for (const body of [
        {},
        { createdBy: ada.userId },
        { title: '' },
        { title: '  ' },
        { status: 'closed' },
        { assigneeId: outsider.userId },
        { body: 'x'.repeat(ISSUE_BODY_MAX + 1) },
      ]) {
        const answer = await call('PATCH', `${w.path}/${made.id}`, ada, body);
        expect({ body, status: answer.status, code: code(answer) }).toEqual({
          body,
          status: 400,
          code: 'VALIDATION_FAILED',
        });
      }
      const kept = await db
        .selectFrom('issues')
        .select(['title', 'assignee_id'])
        .where('id', '=', made.id)
        .executeTakeFirstOrThrow();
      expect(kept).toEqual({ title: 'Keep', assignee_id: null });
    });
  });

  test('only its creator, an admin or an owner deletes: another member is refused, and it stays', async () => {
    await withRollback(async (db) => {
      const call = caller(db);
      const w = await aWorkspace(db, {
        owner: 'owner',
        admin: 'admin',
        maker: 'member',
        other: 'member',
      });
      const [owner, admin, maker, other] = ['owner', 'admin', 'maker', 'other'].map((name) =>
        person(w, name),
      );
      if (!owner || !admin || !maker || !other) throw new Error('missing');
      const make = async (): Promise<string> =>
        ((await call('POST', w.path, maker, { title: 'Doomed' })).body as Issue).id;
      const exists = async (id: string): Promise<boolean> =>
        (await db.selectFrom('issues').select('id').where('id', '=', id).executeTakeFirst()) !==
        undefined;

      const id = await make();
      const refused = await call('DELETE', `${w.path}/${id}`, other);
      expect({ status: refused.status, code: code(refused) }).toEqual({
        status: 403,
        code: 'FORBIDDEN',
      });
      expect(await exists(id)).toBe(true);

      for (const who of [maker, admin, owner]) {
        const target = who === maker ? id : await make();
        const gone = await call('DELETE', `${w.path}/${target}`, who);
        expect({ who: who.username, status: gone.status }).toEqual({
          who: who.username,
          status: 204,
        });
        expect(await exists(target)).toBe(false);
        // Deleted is deleted: the same request is the same one 404.
        expect(code(await call('DELETE', `${w.path}/${target}`, who))).toBe('ISSUE_NOT_FOUND');
      }
    });
  });

  test('somebody else’s issue made by an erased account can still be deleted by an admin, and not by a member', async () => {
    await withRollback(async (db) => {
      const call = caller(db);
      const w = await aWorkspace(db, { admin: 'admin', maker: 'member', other: 'member' });
      const maker = person(w, 'maker');
      const id = ((await call('POST', w.path, maker, { title: 'Orphan' })).body as Issue).id;
      // The key clears when the person's row goes; here, as the column says it may be.
      await db.updateTable('issues').set({ created_by: null }).where('id', '=', id).execute();
      expect(code(await call('DELETE', `${w.path}/${id}`, person(w, 'other')))).toBe('FORBIDDEN');
      expect((await call('DELETE', `${w.path}/${id}`, person(w, 'admin'))).status).toBe(204);
    });
  });
});

describe('integration: a session that has ended writes nothing', () => {
  test('make, change and delete are refused with 401 when the session is no longer live where the write is made, and leave the issue as it was (D-85)', async () => {
    await withRollback(async (db) => {
      const call = caller(db);
      const w = await aWorkspace(db, { bob: 'member' });
      const bob = person(w, 'bob');
      const made = (await call('POST', w.path, bob, { title: 'Alive' })).body as Issue;
      // The request is read as signed in, and by the time the transaction looks the session is past its end: the
      // transaction's clock is a month beyond it (a revocation in that gap is the same row, gone).
      const later = createApp(
        testDependencies({
          database: db,
          clock: fixedClock(new Date(NOW.getTime() + 400 * 24 * 3_600_000)),
          composition,
        }),
      );
      for (const [method, path, body] of [
        ['POST', w.path, { title: 'Late' }],
        ['PATCH', `${w.path}/${made.id}`, { status: 'done' }],
        ['DELETE', `${w.path}/${made.id}`, undefined],
      ] as const) {
        const response = await later.handle(
          new Request(`${ORIGIN}${path}`, {
            method,
            headers: {
              cookie: bob.cookie,
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
        expect({ method, status: response.status }).toEqual({ method, status: 401 });
      }
      const rows = await db
        .selectFrom('issues')
        .select(['title', 'status'])
        .where('workspace_id', '=', w.id)
        .execute();
      expect(rows).toEqual([{ title: 'Alive', status: 'open' }]);
    });
  });
});

describe('integration: who an issue may be given to', () => {
  test('an erased account is refused as an assignee like a stranger, on make and on change', async () => {
    await withRollback(async (db) => {
      const call = caller(db);
      const w = await aWorkspace(db, { ada: 'owner', gone: 'member' });
      const [ada, gone] = [person(w, 'ada'), person(w, 'gone')];
      const made = (await call('POST', w.path, ada, { title: 'Open' })).body as Issue;
      await db
        .updateTable('users')
        .set({ deleted_at: NOW })
        .where('id', '=', gone.userId)
        .execute();
      const refused = [
        await call('POST', w.path, ada, { title: 'x', assigneeId: gone.userId }),
        await call('PATCH', `${w.path}/${made.id}`, ada, { assigneeId: gone.userId }),
      ];
      for (const answer of refused) {
        expect({ status: answer.status, code: code(answer) }).toEqual({
          status: 400,
          code: 'VALIDATION_FAILED',
        });
        expect(JSON.stringify(answer.body)).toContain('assigneeId');
      }
    });
  });
});

describe('integration: what a title and a body may hold', () => {
  test('a NUL, which the database cannot store, is a 400 naming the field, on make and on change, and writes nothing', async () => {
    await withRollback(async (db) => {
      const call = caller(db);
      const w = await aWorkspace(db, { ada: 'owner' });
      const ada = person(w, 'ada');
      const made = (await call('POST', w.path, ada, { title: 'Keep' })).body as Issue;
      for (const [field, body] of [
        ['title', { title: 'a\u0000b' }],
        ['body', { title: 't', body: 'a\u0000b' }],
      ] as const) {
        const answer = await call('POST', w.path, ada, body);
        expect({ field, status: answer.status, code: code(answer) }).toEqual({
          field,
          status: 400,
          code: 'VALIDATION_FAILED',
        });
        expect(JSON.stringify(answer.body)).toContain(field);
        const changed = await call('PATCH', `${w.path}/${made.id}`, ada, { [field]: 'a\u0000b' });
        expect({ field, status: changed.status, code: code(changed) }).toEqual({
          field,
          status: 400,
          code: 'VALIDATION_FAILED',
        });
      }
      const rows = await db
        .selectFrom('issues')
        .select('title')
        .where('workspace_id', '=', w.id)
        .execute();
      expect(rows).toEqual([{ title: 'Keep' }]);
    });
  });

  test('a title is one line without anything that reorders or hides: no newline, no bidi override, no control; a body may span lines', async () => {
    await withRollback(async (db) => {
      const call = caller(db);
      const w = await aWorkspace(db, { ada: 'owner' });
      const ada = person(w, 'ada');
      for (const title of [
        'a\nb',
        'a\r\nb',
        'a\tb',
        'gpj\u202Eexe',
        'a\u2066b',
        'a\u0085b',
        'a\u2028b',
      ]) {
        const answer = await call('POST', w.path, ada, { title });
        expect({ title, status: answer.status, code: code(answer) }).toEqual({
          title,
          status: 400,
          code: 'VALIDATION_FAILED',
        });
      }
      const fine = await call('POST', w.path, ada, {
        title: 'Başlık — ünïcode',
        body: 'one\n\ntwo\tthree',
      });
      expect(fine.status).toBe(201);
      expect((fine.body as Issue).body).toBe('one\n\ntwo\tthree');
    });
  });
});

describe('integration: what issues leaves on the audit trail', () => {
  test('making, finishing, giving and deleting are recorded by id, never by words; a rewrite of the words is not', async () => {
    await withRollback(async (db) => {
      const call = caller(db);
      const w = await aWorkspace(db, { ada: 'owner', bob: 'member' });
      const [ada, bob] = [person(w, 'ada'), person(w, 'bob')];
      const made = (
        await call('POST', w.path, bob, { title: 'Secret plan', body: 'Secret details' })
      ).body as Issue;
      const path = `${w.path}/${made.id}`;
      await call('PATCH', path, ada, { title: 'Rewritten secret', body: 'More secrets' });
      await call('PATCH', path, ada, { status: 'done' });
      await call('PATCH', path, ada, { status: 'done' });
      await call('PATCH', path, ada, { assigneeId: bob.userId });
      await call('PATCH', path, ada, { assigneeId: null });
      await call('DELETE', path, bob);
      // A refused change leaves nothing.
      await call('PATCH', path, ada, { status: 'open' });
      const trail = await db
        .selectFrom('audit_log')
        .select(['actor_user_id', 'action', 'target_type', 'target_id', 'metadata'])
        .where('workspace_id', '=', w.id)
        .orderBy('id')
        .execute();
      expect(trail.map((row) => [row.action, row.actor_user_id])).toEqual([
        ['issue.created', bob.userId],
        ['issue.status_changed', ada.userId],
        ['issue.assigned', ada.userId],
        ['issue.assigned', ada.userId],
        ['issue.deleted', bob.userId],
      ]);
      expect(trail.every((row) => row.target_type === 'issue' && row.target_id === made.id)).toBe(
        true,
      );
      expect(trail.map((row) => row.metadata)).toEqual([
        {},
        { from: 'open', to: 'done' },
        { from: '', to: bob.userId },
        { from: bob.userId, to: '' },
        {},
      ]);
      expect(JSON.stringify(trail)).not.toMatch(/secret/i);
    });
  });
});

describe('integration: how many issues a workspace may hold', () => {
  test('at the cap a new issue is refused with ISSUES_LIMIT, one deleted makes room, and another workspace is its own count', async () => {
    await withRollback(async (db) => {
      const call = caller(db);
      const w = await aWorkspace(db, { ada: 'owner' });
      const other = await aWorkspace(db, { bob: 'owner' });
      const ada = person(w, 'ada');
      // Up to the cap in one statement, ids in the order they would have been made.
      await sql`
        insert into issues (id, workspace_id, title, created_by)
        select ('0199155c-' || lpad(to_hex(n / 65536), 4, '0') || '-7b7f-8c11-' || lpad(to_hex(n % 65536), 12, '0'))::uuid,
               ${w.id}, 'filler', ${ada.userId}
        from generate_series(1, ${ISSUES_PER_WORKSPACE_MAX}) as n`.execute(db);
      const refused = await call('POST', w.path, ada, { title: 'one too many' });
      expect({ status: refused.status, code: code(refused) }).toEqual({
        status: 409,
        code: 'ISSUES_LIMIT',
      });
      // Changing and listing are not made worse by it.
      expect(((await call('GET', `${w.path}?limit=1`, ada)).body as IssuePage).data).toHaveLength(
        1,
      );
      expect((await call('POST', other.path, person(other, 'bob'), { title: 'mine' })).status).toBe(
        201,
      );
      const gone = await db
        .selectFrom('issues')
        .select('id')
        .where('workspace_id', '=', w.id)
        .limit(1)
        .executeTakeFirstOrThrow();
      expect((await call('DELETE', `${w.path}/${gone.id}`, ada)).status).toBe(204);
      expect((await call('POST', w.path, ada, { title: 'room again' })).status).toBe(201);
    });
  });
});

describe('integration: what issues does for the core’s open places', () => {
  test('an erased account is unassigned, and what it made stays under its anonymised row', async () => {
    await withRollback(async (db) => {
      const w = await aWorkspace(db, { ada: 'owner', bob: 'member' });
      const [ada, bob] = [person(w, 'ada'), person(w, 'bob')];
      const call = caller(db);
      const mine = (await call('POST', w.path, bob, { title: 'Bob made', assigneeId: ada.userId }))
        .body as Issue;
      const given = (await call('POST', w.path, ada, { title: 'Ada made', assigneeId: bob.userId }))
        .body as Issue;
      await composition.userErased.run(db, bob.userId, () => undefined);
      const rows = await db
        .selectFrom('issues')
        .select(['id', 'assignee_id', 'created_by'])
        .where('workspace_id', '=', w.id)
        .orderBy('id')
        .execute();
      expect(rows).toEqual([
        { id: mine.id, assignee_id: ada.userId, created_by: bob.userId },
        { id: given.id, assignee_id: null, created_by: ada.userId },
      ]);
    });
  });
});
