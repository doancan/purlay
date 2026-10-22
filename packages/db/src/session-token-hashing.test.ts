/**
 * The session-token hashing plugin at the level of the query it writes (D-11, D-179): every value
 * bound to `sessions.token_hash` leaves as its SHA-256, the same column on any other table leaves as
 * it came, and a shape the plugin cannot read on `sessions` is refused rather than sent with a raw
 * token in it. Compiled, never run: what is checked is the SQL and its parameters.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  createQueryId,
  InsertQueryNode,
  PrimitiveValueListNode,
  sql,
  TableNode,
  ValuesNode,
} from 'kysely';
import { sessionTokenHashing } from './session-token-hashing';
import { unconnectedDatabase } from './testing';

const RAW = 'a-raw-session-token-from-a-cookie';
const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const USER = '00000000-0000-4000-8000-000000000001';

const db = unconnectedDatabase().withPlugin(sessionTokenHashing());

describe('the session-token hashing plugin, on sessions', () => {
  test('hashes the token an INSERT writes', () => {
    const { parameters } = db
      .insertInto('sessions')
      .values({ user_id: USER, token_hash: RAW, expires_at: new Date(0) })
      .compile();
    expect(parameters).toContain(digest(RAW));
    expect(parameters).not.toContain(RAW);
  });

  test('hashes the token an UPDATE sets and the one its WHERE compares', () => {
    const { parameters } = db
      .updateTable('sessions')
      .set({ token_hash: 'the-new-one' })
      .where('token_hash', '=', RAW)
      .compile();
    expect(parameters).toEqual([digest('the-new-one'), digest(RAW)]);
  });

  test('hashes a lookup with the column on either side, and every member of an IN', () => {
    expect(
      db.selectFrom('sessions').selectAll().where('token_hash', '=', RAW).compile().parameters,
    ).toEqual([digest(RAW)]);
    expect(
      db
        .selectFrom('sessions')
        .selectAll()
        .where((eb) => eb(eb.val(RAW), '=', eb.ref('token_hash')))
        .compile().parameters,
    ).toEqual([digest(RAW)]);
    expect(
      db.selectFrom('sessions').selectAll().where('token_hash', 'in', [RAW, 'other']).compile()
        .parameters,
    ).toEqual([digest(RAW), digest('other')]);
  });

  test('hashes the token a DELETE is keyed by', () => {
    expect(db.deleteFrom('sessions').where('token_hash', '=', RAW).compile().parameters).toEqual([
      digest(RAW),
    ]);
  });

  test('hashes every value in a list of expressions, and refuses anything in it that is not one', () => {
    expect(
      db
        .selectFrom('sessions')
        .selectAll()
        .where((eb) => eb('token_hash', 'in', [eb.val(RAW), eb.val('other')]))
        .compile().parameters,
    ).toEqual([digest(RAW), digest('other')]);
    expect(() =>
      db
        .selectFrom('sessions')
        .selectAll()
        .where((eb) => eb('token_hash', 'in', [eb.val(RAW), eb.fn<string>('lower', [eb.val(RAW)])]))
        .compile(),
    ).toThrow(/session-token hashing/);
  });

  test('refuses an operator other than equality, and a value that is not a string', () => {
    expect(() =>
      db.selectFrom('sessions').selectAll().where('token_hash', 'like', `${RAW}%`).compile(),
    ).toThrow(/session-token hashing: `token_hash` under the operator like/);
    expect(() =>
      db
        .selectFrom('sessions')
        .selectAll()
        .where('token_hash', '=', 42 as unknown as string)
        .compile(),
    ).toThrow(/session-token hashing: a number bound/);
  });

  test('keeps a comparison with null as it is', () => {
    expect(
      db.selectFrom('sessions').select('id').where('token_hash', 'is', null).compile().sql,
    ).toContain('is null');
  });

  test('hashes a value that already looks like a digest: a dumped hash is not a token', () => {
    const dumped = digest(RAW);
    expect(
      db.selectFrom('sessions').selectAll().where('token_hash', '=', dumped).compile().parameters,
    ).toEqual([digest(dumped)]);
  });

  test('resolves an alias and a table-qualified column, in a join too', () => {
    expect(
      db.selectFrom('sessions as s').selectAll().where('s.token_hash', '=', RAW).compile()
        .parameters,
    ).toEqual([digest(RAW)]);
    expect(
      db
        .selectFrom('users')
        .innerJoin('sessions', 'sessions.user_id', 'users.id')
        .select('users.id')
        .where('sessions.token_hash', '=', RAW)
        .compile().parameters,
    ).toEqual([digest(RAW)]);
    expect(
      db
        .selectFrom('users as u')
        .innerJoin('sessions as s', 's.user_id', 'u.id')
        .select('u.id')
        .where('s.token_hash', '=', RAW)
        .compile().parameters,
    ).toEqual([digest(RAW)]);
  });

  test('hashes a DELETE and an UPDATE that join another table, read through the joined scope', () => {
    expect(
      db
        .deleteFrom('sessions')
        .using('users')
        .innerJoin('accounts', 'accounts.user_id', 'users.id')
        .whereRef('users.id', '=', 'sessions.user_id')
        .where('sessions.token_hash', '=', RAW)
        .compile().parameters,
    ).toEqual([digest(RAW)]);
    expect(
      db
        .updateTable('sessions')
        .from('users')
        .innerJoin('accounts', 'accounts.user_id', 'users.id')
        .set({ token_hash: 'the-new-one' })
        .where('sessions.token_hash', '=', RAW)
        .compile().parameters,
    ).toEqual([digest('the-new-one'), digest(RAW)]);
  });

  test('hashes inside a subquery on sessions', () => {
    expect(
      db
        .selectFrom('users')
        .select('id')
        .where('id', 'in', (eb) =>
          eb.selectFrom('sessions').select('user_id').where('token_hash', '=', RAW),
        )
        .compile().parameters,
    ).toEqual([digest(RAW)]);
  });
});

describe('the session-token hashing plugin, everywhere else', () => {
  test('leaves workspace_invitations.token_hash alone: insert, update and where', () => {
    expect(
      db
        .insertInto('workspace_invitations')
        .values({
          id: USER,
          workspace_id: USER,
          token_hash: RAW,
          expires_at: new Date(0),
          created_at: new Date(0),
        })
        .compile().parameters,
    ).toContain(RAW);
    expect(
      db
        .updateTable('workspace_invitations')
        .set({ token_hash: RAW })
        .where('token_hash', '=', RAW)
        .compile().parameters,
    ).toEqual([RAW, RAW]);
    expect(
      db.selectFrom('workspace_invitations').selectAll().where('token_hash', '=', RAW).compile()
        .parameters,
    ).toEqual([RAW]);
  });

  test('leaves another table’s column alone even beside sessions in one query', () => {
    expect(
      db
        .selectFrom('workspace_invitations as wi')
        .select('wi.id')
        .where('wi.token_hash', '=', RAW)
        .where('wi.id', 'in', (eb) =>
          eb.selectFrom('sessions').select('sessions.id').where('sessions.token_hash', '=', 'x'),
        )
        .compile().parameters,
    ).toEqual([RAW, digest('x')]);
  });
});

describe('the session-token hashing plugin refuses what it cannot read', () => {
  const refused = (compile: () => unknown): void => {
    expect(compile).toThrow(/session-token hashing/);
  };

  test('a column reached through a derived table built from sessions', () => {
    refused(() =>
      db
        .selectFrom((eb) => eb.selectFrom('sessions').select('token_hash').as('t'))
        .selectAll()
        .where('t.token_hash', '=', RAW)
        .compile(),
    );
  });

  test('a column read from a table function beside sessions', () => {
    refused(() =>
      db
        .selectFrom(['sessions', sql<{ token_hash: string }>`generate_series(1, 2)`.as('g')])
        .select('sessions.id')
        .where(sql.ref('g.token_hash'), '=', RAW)
        .compile(),
    );
  });

  test('a common table expression over sessions', () => {
    refused(() =>
      db
        .with('live', (eb) => eb.selectFrom('sessions').select(['id', 'token_hash']))
        .selectFrom('live')
        .selectAll()
        .where('token_hash', '=', RAW)
        .compile(),
    );
  });

  test('an unqualified column in a subquery whose own tables do not say whose it is', () => {
    refused(() =>
      db
        .selectFrom('sessions')
        .select('id')
        .where('user_id', 'in', (eb) =>
          eb.selectFrom('users').select('id').where(sql.ref('token_hash'), '=', RAW),
        )
        .compile(),
    );
  });

  test('a comparison against something that is not a value', () => {
    refused(() =>
      db
        .selectFrom('sessions')
        .selectAll()
        .where((eb) => eb(eb.ref('token_hash'), '=', eb.fn<string>('lower', [eb.val(RAW)])))
        .compile(),
    );
  });

  test('INSERT … SELECT into sessions', () => {
    refused(() =>
      db
        .insertInto('sessions')
        .columns(['user_id', 'token_hash', 'expires_at'])
        .expression((eb) =>
          eb
            .selectFrom('users')
            .select((inner) => [
              'id',
              inner.val(RAW).as('token_hash'),
              inner.val(new Date(0)).as('expires_at'),
            ]),
        )
        .compile(),
    );
  });

  test('a qualifier that names no table in scope', () => {
    refused(() =>
      db
        .selectFrom('sessions')
        .selectAll()
        .where('x.token_hash' as 'token_hash', '=', RAW)
        .compile(),
    );
  });

  test('the column anywhere a value cannot be read off it: inside a function in the select list', () => {
    refused(() =>
      db
        .selectFrom('sessions')
        .select((eb) => eb.fn<string>('upper', [eb.ref('token_hash')]).as('shouted'))
        .compile(),
    );
  });

  /**
   * A raw statement names the table or the column through text, `sql.table`, `sql.ref` or `sql.id`
   * alike; each is refused, because the values in it are bound where the plugin cannot see whose
   * they are.
   */
  test.each([
    [
      'INSERT through sql.table and sql.ref',
      sql`insert into ${sql.table('sessions')} (${sql.ref('token_hash')}, user_id, expires_at) values (${RAW}, ${USER}, now())`,
    ],
    [
      'a lookup through sql.ref',
      sql`select * from sessions where ${sql.ref('token_hash')} = ${RAW}`,
    ],
    [
      'a lookup through sql.id, both names',
      sql`select * from ${sql.id('sessions')} where ${sql.id('token_hash')} = ${RAW}`,
    ],
    ['an UPDATE through sql.id', sql`update sessions set ${sql.id('token_hash')} = ${RAW}`],
    [
      'a lookup through sql.table and sql.ref',
      sql`select * from ${sql.table('sessions')} where ${sql.ref('token_hash')} = ${RAW}`,
    ],
    [
      'a DELETE through sql.table, the column in text',
      sql`delete from ${sql.table('sessions')} where token_hash = ${RAW}`,
    ],
  ])('a raw statement: %s', (_why, statement) => {
    refused(() => statement.compile(db));
  });

  test('a raw fragment inside a builder query on sessions that names the column', () => {
    refused(() =>
      db
        .selectFrom('sessions')
        .selectAll()
        .where(sql<boolean>`${sql.ref('token_hash')} = ${RAW}`)
        .compile(),
    );
  });

  test('a raw statement that names the column', () => {
    refused(() => sql`select * from sessions where token_hash = ${RAW}`.compile(db));
  });

  /**
   * Lexical detection of the column cannot be complete — a name split across fragments, an escaped
   * identifier, a column named by a value — so a raw statement that reaches `sessions` at all is
   * refused, and an INSERT into it must name its columns.
   */
  test.each([
    [
      'the column split across fragments',
      sql`select * from sessions where token_${sql.raw('hash')} = ${RAW}`,
    ],
    [
      'the table split across fragments',
      sql`select * from sess${sql.raw('ions')} where token_hash = ${RAW}`,
    ],
    ['an escaped identifier', sql`select * from sessions where U&"token\\005fhash" = ${RAW}`],
    [
      'the column named by a value',
      sql`select * from sessions s where row_to_json(s)->>${'token_hash'} = ${RAW}`,
    ],
    [
      'an INSERT with no column list',
      sql`insert into sessions values (gen_random_uuid(), ${USER}, ${RAW}, now(), now(), now())`,
    ],
    ['a quoted, schema-qualified table', sql`select id from public."SESSIONS"`],
    ['a statement that binds nothing', sql`copy sessions from stdin`],
  ])('a raw statement on sessions, however it is spelt: %s', (_why, statement) => {
    refused(() => statement.compile(db));
  });

  test('an INSERT into sessions with no column list, from the builder', () => {
    refused(() =>
      db
        .insertInto('sessions')
        .expression(sql`values (gen_random_uuid(), ${USER}, ${RAW})`)
        .compile(),
    );
  });

  test('an INSERT into sessions by position, VALUES and all', () => {
    // No builder writes one — `values()` always names its columns — so the statement is built from
    // its nodes, as an upgrade of the library could send it.
    const node = InsertQueryNode.cloneWith(InsertQueryNode.create(TableNode.create('sessions')), {
      values: ValuesNode.create([PrimitiveValueListNode.create([USER, RAW, new Date(0)])]),
    });
    refused(() => sessionTokenHashing().transformQuery({ node, queryId: createQueryId() }));
  });

  test('INSERT … SELECT into sessions with no column list', () => {
    refused(() =>
      db
        .insertInto('sessions')
        .expression(
          db.selectFrom('users').select((eb) => [eb.val('x').as('id'), eb.val(RAW).as('t')]),
        )
        .compile(),
    );
  });

  test('INSERT … SELECT into sessions that does not name the token at all', () => {
    refused(() =>
      db
        .insertInto('sessions')
        .columns(['user_id', 'expires_at'])
        .expression(db.selectFrom('users').select(['id', 'created_at']))
        .compile(),
    );
  });

  test('a raw fragment that binds nothing but names the column through sql.id, in a builder statement', () => {
    refused(() =>
      db
        .selectFrom('sessions')
        .selectAll()
        .where(sql<boolean>`${sql.id('token_hash')} = upper(${sql.id('token_hash')})`)
        .compile(),
    );
  });

  test('a raw fragment that binds a value inside a builder statement on sessions', () => {
    refused(() =>
      db
        .selectFrom('sessions')
        .selectAll()
        .where(sql<boolean>`row_to_json(sessions)->>${'token_hash'} = ${RAW}`)
        .compile(),
    );
  });

  test('…while a raw fragment that binds nothing, and raw SQL about another table, still go through', () => {
    expect(
      db
        .selectFrom('sessions')
        .selectAll()
        .where('expires_at', '>', sql<Date>`now()`)
        .where('token_hash', '=', RAW)
        .compile().parameters,
    ).toEqual([digest(RAW)]);
    expect(
      sql`select * from workspace_invitations where token_hash = ${RAW}`.compile(db).parameters,
    ).toEqual([RAW]);
  });

  test('MERGE into sessions', () => {
    refused(() =>
      db
        .mergeInto('sessions')
        .using('users', 'users.id', 'sessions.user_id')
        .whenMatched()
        .thenDelete()
        .compile(),
    );
  });
});
