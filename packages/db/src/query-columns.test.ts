import { describe, expect, test } from 'bun:test';
import { relevantToSchema, resolveReference, scanSource } from './query-columns';

const COLUMNS = new Map([
  ['issues', new Set(['id', 'status', 'workspace_id', 'assignee_id'])],
  ['users', new Set(['id', 'deleted_at'])],
]);

const written = (code: string): string[] =>
  scanSource('x.ts', code).references.map((reference) => reference.written);

describe('what the scan reads', () => {
  test('an upsert guard shares its query with the unique target columns, without counting another callback’s chain', () => {
    const scan = scanSource(
      'x.ts',
      "db.insertInto('issues').values(row).onConflict(c => c.columns(['workspace_id', 'id']).doUpdateSet(row).where('issues.status', '!=', 'closed'));",
    );
    expect(scan.references.map((r) => [r.written, r.scope[0]?.table])).toEqual([
      ['workspace_id', 'issues'],
      ['id', 'issues'],
      ['issues.status', 'issues'],
    ]);
    expect(new Set(scan.references.map((r) => r.query)).size).toBe(1);
    expect(
      written(
        "db.insertInto('issues').onConflict(function(c) { return c.column('id').doUpdateSet(row).where('status', '!=', 'closed'); });",
      ),
    ).toEqual(['id', 'status']);
    expect(
      written(
        "db.insertInto('issues').onConflict(c => other.columns(['id']).where('issues.status', '=', 'open')); ",
      ),
    ).toEqual(['issues.status']);
    expect(
      written(
        "db.insertInto('issues').onConflict(c => c.columns(variable).where('issues.status', '=', 'open')); ",
      ),
    ).toEqual(['issues.status']);
  });

  test('a filter and an order by a literal column, with the table of the chain', () => {
    const { references, blind } = scanSource(
      'x.ts',
      "const q = db.selectFrom('issues').where('status', '=', 1).orderBy('id', 'desc');",
    );
    expect(references.map((r) => [r.clause, r.written, r.scope[0]?.table])).toEqual([
      ['orderBy', 'id', 'issues'],
      ['where', 'status', 'issues'],
    ]);
    expect(blind).toEqual([]);
  });

  test('one statement is one query, and two statements are two', () => {
    const { references } = scanSource(
      'x.ts',
      "a.selectFrom('issues').where('id', '=', 1);\na.selectFrom('issues').where('id', '=', 2);\na.selectFrom('issues').where('status', '=', 2).where('id', '=', 3);",
    );
    expect(new Set(references.map((r) => r.query)).size).toBe(3);
    expect(references[2]?.query).toBe(references[3]?.query);
  });

  test('a query built in steps on a variable is still the table it started from', () => {
    const { references } = scanSource(
      'x.ts',
      "async () => {\n let statement = db.selectFrom('issues').select('id');\n if (a) statement = statement.where('status', '=', 1);\n return statement;\n};",
    );
    expect(references.map((r) => [r.written, r.scope[0]?.table])).toEqual([['status', 'issues']]);
  });

  test('a join names its table in its own on-clause, with an alias', () => {
    const { references } = scanSource(
      'x.ts',
      "db.selectFrom('issues as i').innerJoin('users as u', 'u.id', 'i.assignee_id').where('u.deleted_at', 'is', null);",
    );
    expect(references.map((r) => [r.clause, r.written])).toEqual([
      ['where', 'u.deleted_at'],
      ['join', 'u.id'],
      ['join', 'i.assignee_id'],
    ]);
    expect(references[1]?.scope.map((entry) => entry.alias)).toEqual(['i', 'u']);
  });

  test('whereRef, on and onRef give their column arguments', () => {
    expect(
      written(
        "eb.selectFrom('users').whereRef('users.id', '=', 'issues.assignee_id');\njoin.on('a.x', '=', 1).onRef('a.y', '=', 'b.z');\nb.having('x', '>', 1);",
      ).sort(),
    ).toEqual(['a.x', 'a.y', 'b.z', 'issues.assignee_id', 'users.id'].sort());
  });

  test('a composite join callback shares the filtered statement and resolves both aliases', () => {
    const scan = scanSource(
      'x.ts',
      "db.selectFrom('issues as i').leftJoin('users as u', join => join.onRef('u.id', '=', 'i.assignee_id').on('u.deleted_at', 'is', null)).where('i.status', '=', 'open');",
    );
    expect(new Set(scan.references.map((r) => r.query)).size).toBe(1);
    expect(scan.references.map((r) => resolveReference(r, COLUMNS))).toEqual([
      { table: 'issues', column: 'status' },
      { table: 'users', column: 'deleted_at' },
      { table: 'users', column: 'id' },
      { table: 'issues', column: 'assignee_id' },
    ]);
  });

  test('an unrelated builder inside a join callback does not inherit its enclosing query', () => {
    const scan = scanSource(
      'x.ts',
      "db.selectFrom('issues').innerJoin('users', join => other.onRef('users.id', '=', 'issues.assignee_id')).where('users.deleted_at', 'is', null);",
    );
    const [filter, other] = scan.references;
    expect(filter?.scope).toHaveLength(2);
    expect(other?.scope).toEqual([]);
    expect(other?.query).not.toBe(filter?.query);
  });

  test('a factory, an unnamed joined table or a non-join callback cannot supply a known join scope', () => {
    for (const code of [
      "db.selectFrom('issues').innerJoin('users', join => wrap(join).onRef('users.id', '=', 'issues.assignee_id'));",
      "db.selectFrom('issues').innerJoin(table, join => join.onRef('users.id', '=', 'issues.assignee_id'));",
      "list.map(join => join.onRef('users.id', '=', 'issues.assignee_id'));",
    ]) {
      const scan = scanSource('x.ts', code);
      expect(scan.references).toHaveLength(2);
      expect(scan.references.every((reference) => reference.scope.length === 0)).toBe(true);
    }
  });

  test('a function-expression join callback resolves its own builder and statement', () => {
    const scan = scanSource(
      'x.ts',
      "db.selectFrom('issues as i').innerJoin('users as u', function(join) { return join.onRef('u.id', '=', 'i.assignee_id'); }).where('u.deleted_at', 'is', null);",
    );
    expect(new Set(scan.references.map((reference) => reference.query)).size).toBe(1);
    expect(scan.references.map((reference) => resolveReference(reference, COLUMNS))).toEqual([
      { table: 'users', column: 'deleted_at' },
      { table: 'users', column: 'id' },
      { table: 'issues', column: 'assignee_id' },
    ]);
  });

  test('unknown transforms and shadowed bindings do not borrow a callback query', () => {
    for (const body of [
      "join.$call(unknownFactory).onRef('users.deleted_at', '=', 'issues.assignee_id')",
      "{ const join = unknownFactory(); return join.onRef('users.deleted_at', '=', 'issues.assignee_id'); }",
      "{ { const join = unknownFactory(); return join.onRef('users.deleted_at', '=', 'issues.assignee_id'); } }",
      "(join = unknownFactory(), join.onRef('users.deleted_at', '=', 'issues.assignee_id'))",
    ]) {
      const scan = scanSource(
        'x.ts',
        ` db.selectFrom('issues').innerJoin('users', join => ${body}).where('users.id', '=', 1);`,
      );
      const [filter, unknown] = scan.references;
      expect(filter?.scope).toHaveLength(2);
      expect(unknown?.scope).toEqual([]);
      expect(unknown?.query).not.toBe(filter?.query);
    }
  });

  test('a callback parameter shadows an outer builder and supplies its own aliases', () => {
    const scan = scanSource(
      'x.ts',
      "const join = db.selectFrom('issues'); db.selectFrom('issues as i').innerJoin('users as u', join => join.onRef('u.id', '=', 'i.assignee_id')).where('u.deleted_at', 'is', null);",
    );
    const [filter, joined] = scan.references;
    expect(joined?.query).toBe(filter?.query);
    expect(joined === undefined ? undefined : resolveReference(joined, COLUMNS)).toEqual({
      table: 'users',
      column: 'id',
    });
  });

  test('unknown operations before and after a transform retain separate identities', () => {
    const scan = scanSource(
      'x.ts',
      "db.selectFrom('issues').innerJoin('users', join => join.onRef('users.id', '=', 'issues.assignee_id').$call(unknownFactory).on('users.deleted_at', 'is', null));",
    );
    expect(new Set(scan.references.map((reference) => reference.query)).size).toBe(2);
    expect(scan.references.every((reference) => reference.scope.length === 0)).toBe(true);
  });

  test('a helper query keeps its literal filters together until an opaque transform', () => {
    const together = scanSource(
      'x.ts',
      "const q = helper().where('users.id', '=', 1); q.where('users.deleted_at', 'is', null);",
    );
    expect(new Set(together.references.map((reference) => reference.query)).size).toBe(1);
    const split = scanSource(
      'x.ts',
      "helper().where('users.id', '=', 1).$call(unknownFactory).where('users.deleted_at', 'is', null);",
    );
    expect(new Set(split.references.map((reference) => reference.query)).size).toBe(2);
  });

  test('a conditional can retain the original query only through directly returned filters', () => {
    const retained = scanSource(
      'x.ts',
      "helper().where('users.id', '=', 1).$if(flag, query => query.where('id', '>', after)).orderBy('users.deleted_at');",
    );
    expect(new Set(retained.references.map((reference) => reference.query)).size).toBe(1);
    for (const callback of [
      'unknownFactory',
      '() => unknownFactory()',
      'query => query.$call(unknownFactory)',
      'query => other',
      '({ query }) => query',
      'query => { const query = unknownFactory(); return query; }',
    ]) {
      const split = scanSource(
        'x.ts',
        `helper().where('users.id', '=', 1).$if(flag, ${callback}).orderBy('users.deleted_at');`,
      );
      expect(new Set(split.references.map((reference) => reference.query)).size).toBe(2);
    }
  });

  test('nearer parameters, declarations and loop bindings never inherit an outer query', () => {
    for (const use of [
      "function read(q) { return q.where('users.deleted_at', 'is', null); }",
      "function read({ q }) { return q.where('users.deleted_at', 'is', null); }",
      "function read([, q]) { return q.where('users.deleted_at', 'is', null); }",
      "{ let q; q.where('users.deleted_at', 'is', null); }",
      "{ const { q } = unknownFactory(); q.where('users.deleted_at', 'is', null); }",
      "{ function q() {} q.where('users.deleted_at', 'is', null); }",
      "{ class q {} q.where('users.deleted_at', 'is', null); }",
      "try {} catch (q) { q.where('users.deleted_at', 'is', null); }",
      "for (const q of queries) { q.where('users.deleted_at', 'is', null); }",
      "(function q() { q.where('users.deleted_at', 'is', null); })();",
    ]) {
      const scan = scanSource('x.ts', `const q = helper().where('users.id', '=', 1); ${use}`);
      expect(scan.references).toHaveLength(2);
      expect(scan.references[0]?.query).not.toBe(scan.references[1]?.query);
    }
  });

  test('what it cannot read is counted, not guessed', () => {
    const { references, blind } = scanSource(
      'x.ts',
      "db.selectFrom('issues').where((eb) => eb('id', '=', 1)).orderBy(sql`id`).where(name, '=', 1);\nconst raw = sql`select 1`;\nhelper(db).where('status', '=', 1);\ndb.selectFrom('issues').innerJoin('users', (join) => join.onRef('a', '=', 'b')).where('id a b', '=', 1);",
    );
    expect(references.map((reference) => reference.written)).toEqual(['a', 'b']);
    expect(blind.map((b) => b.kind).sort()).toEqual([
      'callback',
      'callback',
      'not-a-literal',
      'not-a-literal',
      'not-a-literal',
      'raw-sql',
      'raw-sql',
      'unknown-chain',
    ]);
  });

  test('a chain behind parentheses, an await or a cast is read through them', () => {
    expect(
      scanSource(
        'x.ts',
        "async () => (await (db.selectFrom('issues') as Q)).where('status', '=', 1);",
      ).references[0]?.scope[0]?.table,
    ).toBe('issues');
  });

  test('a qualified column of a chain from a parameter is kept, for the table it names', () => {
    expect(written("(query) => query.where('issues.status', '=', 1);")).toEqual(['issues.status']);
  });

  test('a variable without an initializer or that refers to itself ends the chain', () => {
    expect(
      written("let q;\nq.where('issues.id', '=', 1);\nlet r = r.where('issues.id', '=', 1);"),
    ).toEqual(['issues.id', 'issues.id']);
  });
});

describe('which table a column belongs to', () => {
  const reference = (code: string): ReturnType<typeof scanSource>['references'][number] => {
    const [first] = scanSource('x.ts', code).references;
    if (first === undefined) throw new Error('no reference');
    return first;
  };

  test('an uninstalled module is outside this schema, while unknown or missing core tables and misspelled columns stay guarded', () => {
    const owners = { issues: 'issues', users: 'core' };
    const coreOnly = new Map([['users', new Set(['id'])]]);
    const moduleQuery = reference("db.selectFrom('issues').where('status', '=', 'open')");
    expect(relevantToSchema(moduleQuery, coreOnly, owners)).toBe(false);
    expect(relevantToSchema(moduleQuery, COLUMNS, owners)).toBe(true);
    const joined = reference(
      "db.selectFrom('users').innerJoin('issues', 'issues.assignee_id', 'users.id').where('users.id', '=', 1)",
    );
    expect(relevantToSchema(joined, coreOnly, owners)).toBe(false);
    expect(relevantToSchema(joined, COLUMNS, owners)).toBe(true);
    expect(
      relevantToSchema(reference("db.selectFrom('users').where('id', '=', 1)"), new Map(), owners),
    ).toBe(true);
    const unknown = reference("db.selectFrom('misspelled').where('id', '=', 1)");
    expect(relevantToSchema(unknown, coreOnly, owners)).toBe(true);
    expect(resolveReference(unknown, coreOnly)).toBeUndefined();
    const wrongColumn = reference("db.selectFrom('users').where('wrong', '=', 1)");
    expect(relevantToSchema(wrongColumn, coreOnly, owners)).toBe(true);
    expect(resolveReference(wrongColumn, coreOnly)).toBeUndefined();
  });

  test('a qualifier is an alias of the chain, or else a table of the database', () => {
    expect(
      resolveReference(
        reference("db.selectFrom('issues as i').where('i.status', '=', 1)"),
        COLUMNS,
      ),
    ).toEqual({ table: 'issues', column: 'status' });
    expect(resolveReference(reference("(q) => q.where('users.id', '=', 1)"), COLUMNS)).toEqual({
      table: 'users',
      column: 'id',
    });
  });

  test('a qualifier no table answers to, or a column the table lacks, is not resolved', () => {
    expect(
      resolveReference(reference("(q) => q.where('cte.id', '=', 1)"), COLUMNS),
    ).toBeUndefined();
    expect(
      resolveReference(reference("(q) => q.where('users.status', '=', 1)"), COLUMNS),
    ).toBeUndefined();
  });

  test('a bare column belongs to the one table of the chain that has it', () => {
    const joined = "db.selectFrom('issues').innerJoin('users', 'users.id', 'issues.assignee_id')";
    expect(
      resolveReference(reference(`${joined}.where('deleted_at', 'is', null)`), COLUMNS),
    ).toEqual({
      table: 'users',
      column: 'deleted_at',
    });
    expect(resolveReference(reference(`${joined}.where('id', '=', 1)`), COLUMNS)).toBeUndefined();
    expect(resolveReference(reference(`${joined}.where('rank', '=', 1)`), COLUMNS)).toBeUndefined();
  });
});
