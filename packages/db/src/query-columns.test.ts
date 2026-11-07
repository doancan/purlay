import { describe, expect, test } from 'bun:test';
import { resolveReference, scanSource } from './query-columns';

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

  test('what it cannot read is counted, not guessed', () => {
    const { references, blind } = scanSource(
      'x.ts',
      "db.selectFrom('issues').where((eb) => eb('id', '=', 1)).orderBy(sql`id`).where(name, '=', 1);\nconst raw = sql`select 1`;\nhelper(db).where('status', '=', 1);\ndb.selectFrom('issues').innerJoin('users', (join) => join.onRef('a', '=', 'b')).where('id a b', '=', 1);",
    );
    expect(references).toEqual([]);
    expect(blind.map((b) => b.kind).sort()).toEqual([
      'callback',
      'callback',
      'not-a-literal',
      'not-a-literal',
      'not-a-literal',
      'raw-sql',
      'raw-sql',
      'unknown-chain',
      'unknown-chain',
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
