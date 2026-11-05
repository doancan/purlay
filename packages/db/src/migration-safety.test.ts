/**
 * What a migration may do to a table that keeps growing (D-86).
 *
 * Migration 0058 updated every `messages` row in one statement (85 s on 1.3M rows) and 0060 added seven
 * constraints that PostgreSQL checked against every row under an ACCESS EXCLUSIVE lock (about a second per 1.3M
 * rows). Both shipped, and a shipped migration is not edited, so this holds the next one to the recipe instead
 * (`DATA.md` §5): batch the rewrite, add a constraint `NOT VALID` and `VALIDATE` it apart, build an index
 * `CONCURRENTLY` outside the transaction, and change a column's type by adding a new one.
 *
 * **What it reads.** Each statement of each migration with its comments removed, for a table that is not
 * `swept` and not a one-row table, by `TABLE_LIFECYCLE` (a table that is added to the schema decides this there,
 * so there is no second list). A file that creates the table itself is exempt: nothing is in it yet.
 *
 * **What it does not see.** A table named through a variable or a `format()` in a `DO` block; whether a `LIMIT`
 * is inside a loop that runs to the end (any `LIMIT` in the statement counts as a batch); `SET NOT NULL` and
 * `ADD UNIQUE` or `ADD PRIMARY KEY` (each a scan, and an index build); a table's size (a small table needs the
 * opt-out too); and what a migration does through a function it calls. It says what is in the file, not what the
 * database holds.
 *
 * **Shipped files.** The ones before the guard that do any of it are in `GRANDFATHERED`, each with why, capped,
 * and an entry for a file that no longer offends fails: the list only shrinks. A file after `LAST_GRANDFATHERED`
 * cannot be listed. It carries `-- purlay: large-table-ok: <why>` instead, and the marker on a file with
 * nothing to excuse fails too.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { MIGRATIONS_DIRECTORY, PRODUCT_MIGRATION_SETS } from './migrator';
import { executableText, splitStatements } from './statements';
import { TABLE_LIFECYCLE, type TableLifecycle } from './table-lifecycle';

const NO_TRANSACTION = /^--\s*purlay:\s*no-transaction\s*$/m;
const OPT_OUT_MARKER = /^--\s*purlay:\s*large-table-ok\b.*$/m;
const OPT_OUT_REASON = /^--\s*purlay:\s*large-table-ok:\s*(\S.*)$/m;
const MIN_OPT_OUT_REASON_LENGTH = 20;

/** Tables whose rows are bounded, so a rewrite of them is brief: swept on a schedule, or one row for life. */
const growsOnItsOwn = (decision: TableLifecycle): boolean => {
  if (decision.retention === 'swept') return false;
  const keptForever = typeof decision.retention === 'object';
  const holdsNobody = typeof decision.erasure === 'object' && 'nobody' in decision.erasure;
  return !(keptForever && holdsNobody);
};

const GROWING_TABLES: ReadonlySet<string> = new Set(
  Object.entries(TABLE_LIFECYCLE)
    .filter(([, decision]) => growsOnItsOwn(decision))
    .map(([table]) => table),
);

const statementsOf = (text: string): string[] =>
  splitStatements(text).map((statement) => executableText(statement));

/** The comma-separated parts of an `ALTER TABLE`, at the top level of its parentheses. */
const clausesOf = (body: string): string[] => {
  const clauses: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i];
    if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === ',' && depth === 0) {
      clauses.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  clauses.push(body.slice(start).trim());
  return clauses;
};

const UPDATE_OF = /(?<![\w"])UPDATE\s+(?:ONLY\s+)?"?(\w+)"?(?:\s+(?:AS\s+)?\w+)?\s+SET\b/gi;
const DELETE_FROM = /(?<![\w"])DELETE\s+FROM\s+(?:ONLY\s+)?"?(\w+)"?/gi;
const CREATE_TABLE = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/i;
const ALTER_TABLE = /^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?"?(\w+)"?\s+([\s\S]*)$/i;
const CREATE_INDEX =
  /^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?\S+\s+ON\s+(?:ONLY\s+)?"?(\w+)"?/i;
const DEFINES_CODE = /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\b/i;
const ADDS_CONSTRAINT_TO_CHECK = /\b(?:CHECK|FOREIGN\s+KEY|REFERENCES)\b/i;
const CHANGES_TYPE = /^ALTER\s+COLUMN\s+"?\w+"?\s+(?:SET\s+DATA\s+)?TYPE\b/i;

/** Every way the file, as written, would hold a growing table under a long lock or a long write. */
const problemsOf = (text: string): string[] => {
  const code = statementsOf(text);
  const created = new Set(code.map((statement) => CREATE_TABLE.exec(statement)?.[1]));
  const large = (table: string | undefined): table is string =>
    table !== undefined && GROWING_TABLES.has(table) && !created.has(table);
  const problems: string[] = [];

  for (const statement of code) {
    if (DEFINES_CODE.test(statement)) continue;
    const batched = /\bLIMIT\b/i.test(statement);
    for (const match of statement.matchAll(UPDATE_OF)) {
      if (large(match[1]) && !batched)
        problems.push(`updates ${match[1]} without a LIMIT to batch by`);
    }
    for (const match of statement.matchAll(DELETE_FROM)) {
      if (large(match[1]) && !batched) {
        problems.push(`deletes from ${match[1]} without a LIMIT to batch by`);
      }
    }

    const alter = ALTER_TABLE.exec(statement);
    if (alter !== null && large(alter[1])) {
      for (const clause of clausesOf(alter[2] ?? '')) {
        if (
          /^ADD\b/i.test(clause) &&
          ADDS_CONSTRAINT_TO_CHECK.test(clause) &&
          !/\bNOT\s+VALID\b/i.test(clause)
        ) {
          problems.push(`adds a CHECK or FOREIGN KEY to ${alter[1]} without NOT VALID`);
        }
        if (CHANGES_TYPE.test(clause)) {
          problems.push(`changes the type of a column of ${alter[1]}, which rewrites it`);
        }
      }
    }

    const index = CREATE_INDEX.exec(statement);
    if (index !== null && large(index[2])) {
      if (index[1] === undefined) {
        problems.push(`builds an index on ${index[2]} without CONCURRENTLY`);
      } else if (!NO_TRANSACTION.test(text)) {
        problems.push(`builds an index on ${index[2]} inside the migrator's transaction`);
      }
    }
  }
  return [...new Set(problems)];
};

interface MigrationFile {
  /** `0058_x.sql` in the core's directory, `chat/0001_x.sql` in a module's set. */
  readonly name: string;
  /** `core` or the set's id. */
  readonly set: string;
  readonly number: number;
  readonly text: string;
}

const readSet = (set: string, directory: string): MigrationFile[] =>
  readdirSync(directory)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => ({
      name: set === 'core' ? file : `${set}/${file}`,
      set,
      number: Number(file.slice(0, 4)),
      text: readFileSync(join(directory, file), 'utf8'),
    }));

const ALL_FILES: readonly MigrationFile[] = [
  ...readSet('core', MIGRATIONS_DIRECTORY),
  ...PRODUCT_MIGRATION_SETS.flatMap((set) => readSet(set.id, set.directory)),
];

/** The number of the last migration of each set when the guard was added: a file above it is held to the rule outright. */
const LAST_GRANDFATHERED: Readonly<Record<string, number>> = {
  core: 80,
  chat: 4,
  issues: 1,
};

const isNew = (file: MigrationFile): boolean => file.number > (LAST_GRANDFATHERED[file.set] ?? 0);

const hasReasonedOptOut = (text: string): boolean =>
  (OPT_OUT_REASON.exec(text)?.[1] ?? '').length >= MIN_OPT_OUT_REASON_LENGTH;

/**
 * Shipped files that do what the rule refuses, each with why that did or did not cost. It may only shrink: a
 * migration is not edited once it is shipped, and nothing joins it.
 */
const GRANDFATHERED: Readonly<Record<string, string>> = {
  '0022_audit_session.sql':
    'a nullable key column and a plain index on audit_log, in the migrator’s transaction: shipped before the recipe, the table then small',
  '0024_push_subscriptions.sql':
    'adds users.locale with an inline CHECK, which the table is scanned for under the lock: shipped before the recipe',
  '0027_attachment_channels.sql':
    'one unbatched UPDATE of the attachments rows that hang on a message, in a file that otherwise builds its indexes CONCURRENTLY',
  '0033_feed_failures.sql':
    'a CHECK on the repository feeds without NOT VALID: one row per connected repository, so brief; not measured',
  '0036_incident_responders.sql':
    'a CHECK re-added on incident_updates without NOT VALID: bounded by incidents; not measured',
  '0037_incident_writeup.sql':
    'CHECKs on incidents and incident_updates without NOT VALID: bounded by incidents; not measured',
  '0045_users_github_login.sql':
    'one unbatched UPDATE of users and a plain index, in the migrator’s transaction: one row per person; not measured',
  '0055_backfill_existing_identities.sql':
    'one unbatched UPDATE of users: one row per person; not measured',
  '0058_message_changed_at.sql':
    'one unbatched UPDATE of every messages row: 85 s on 1.3M rows in the scale benchmark, which is why this guard exists',
  '0060_question_knowledge.sql':
    'seven columns and seven CHECKs on messages without NOT VALID: ACCESS EXCLUSIVE held about a second per 1.3M rows in the scale benchmark',
  '0065_account_suspension.sql':
    'a key column added to server_audit_log without NOT VALID: the server’s own trail, small; not measured',
  '0071_workspace_deletion.sql':
    'a CHECK on workspaces and a key on server_audit_log without NOT VALID: small tables; not measured',
  '0079_attachment_claims.sql':
    'one unbatched UPDATE of the attachments rows that hang on a message: attachments grow with messages; not measured',
};
const MAX_GRANDFATHERED = 13;

describe('migration safety on a growing table', () => {
  test('the tables the rule covers are the growing ones, by the lifecycle decision', () => {
    for (const table of ['messages', 'notifications', 'audit_log', 'reactions', 'attachments']) {
      expect(GROWING_TABLES).toContain(table);
    }
    for (const table of ['sessions', 'rate_limits', 'job_runs', 'server_settings', 'setup_state']) {
      expect(GROWING_TABLES).not.toContain(table);
    }
  });

  test('a new migration does none of it, or says in the file why it may', () => {
    const offending = ALL_FILES.filter((file) => isNew(file) && !hasReasonedOptOut(file.text))
      .map((file) => ({ file: file.name, problems: problemsOf(file.text) }))
      .filter((entry) => entry.problems.length > 0);
    expect(
      offending,
      'See DATA.md §5: batch it, add the constraint NOT VALID and VALIDATE it apart, CREATE INDEX CONCURRENTLY outside the transaction. If the table is small or empty on every instance, say so in the file: `-- purlay: large-table-ok: <why>`.',
    ).toEqual([]);
  });

  test('an opt-out gives a reason, and is on a file that has something to excuse', () => {
    for (const file of ALL_FILES) {
      if (!OPT_OUT_MARKER.test(file.text)) continue;
      expect({ file: file.name, reasoned: hasReasonedOptOut(file.text) }).toEqual({
        file: file.name,
        reasoned: true,
      });
      expect({ file: file.name, excuses: problemsOf(file.text).length > 0 }).toEqual({
        file: file.name,
        excuses: true,
      });
    }
  });

  test('the shipped files that do it are a list that only shrinks', () => {
    const offending = ALL_FILES.filter(
      (file) => !isNew(file) && problemsOf(file.text).length > 0,
    ).map((file) => file.name);
    expect(offending.filter((name) => !(name in GRANDFATHERED))).toEqual([]);
    expect(Object.keys(GRANDFATHERED).filter((name) => !offending.includes(name))).toEqual([]);
    expect(Object.keys(GRANDFATHERED).length).toBeLessThanOrEqual(MAX_GRANDFATHERED);
    for (const reason of Object.values(GRANDFATHERED)) {
      expect(reason.length).toBeGreaterThanOrEqual(MIN_OPT_OUT_REASON_LENGTH);
    }
  });

  test('a file added after the guard is never in the list', () => {
    const listed = ALL_FILES.filter((file) => file.name in GRANDFATHERED);
    expect(listed.filter(isNew)).toEqual([]);
  });

  test('the baseline names every set, and stops inside it', () => {
    for (const set of new Set(ALL_FILES.map((file) => file.set))) {
      const count = ALL_FILES.filter((file) => file.set === set).length;
      expect(LAST_GRANDFATHERED[set]).toBeLessThanOrEqual(count);
    }
  });
});

describe('...and the check does catch each way of getting it wrong', () => {
  test('an unbatched UPDATE or DELETE, and a batched one', () => {
    expect(problemsOf('UPDATE messages SET changed_at = now() WHERE changed_at IS NULL;')).toEqual([
      'updates messages without a LIMIT to batch by',
    ]);
    expect(problemsOf('DELETE FROM notifications WHERE read_at < now();')).toEqual([
      'deletes from notifications without a LIMIT to batch by',
    ]);
    const batched =
      'UPDATE messages SET x = 1 WHERE id IN (SELECT id FROM messages WHERE x IS NULL LIMIT 5000);';
    expect(problemsOf(batched)).toEqual([]);
  });

  test('a table that is small by decision, or created in the file, is not one', () => {
    expect(problemsOf('UPDATE sessions SET x = 1;')).toEqual([]);
    expect(problemsOf('CREATE TABLE messages (id int);\nUPDATE messages SET id = 1;')).toEqual([]);
    expect(problemsOf('CREATE TABLE messages (id int);\nCREATE INDEX i ON messages (id);')).toEqual(
      [],
    );
  });

  test('a CHECK or FOREIGN KEY without NOT VALID, in any clause of the statement', () => {
    expect(
      problemsOf('ALTER TABLE messages ADD COLUMN x INT, ADD CONSTRAINT c CHECK (x > 0);'),
    ).toEqual(['adds a CHECK or FOREIGN KEY to messages without NOT VALID']);
    expect(
      problemsOf('ALTER TABLE reactions ADD CONSTRAINT f FOREIGN KEY (a) REFERENCES users (id);'),
    ).toHaveLength(1);
    expect(
      problemsOf('ALTER TABLE messages ADD COLUMN x UUID REFERENCES users(id) ON DELETE SET NULL;'),
    ).toHaveLength(1);
    expect(problemsOf('ALTER TABLE messages ADD CONSTRAINT c CHECK (x > 0) NOT VALID;')).toEqual(
      [],
    );
    expect(problemsOf('ALTER TABLE messages VALIDATE CONSTRAINT c;')).toEqual([]);
    expect(problemsOf('ALTER TABLE messages ADD COLUMN x INT NOT NULL DEFAULT 0;')).toEqual([]);
  });

  test('an index built plainly, or CONCURRENTLY inside the transaction', () => {
    expect(problemsOf('CREATE INDEX i ON attachments (a);')).toEqual([
      'builds an index on attachments without CONCURRENTLY',
    ]);
    expect(problemsOf('CREATE INDEX CONCURRENTLY i ON attachments (a);')).toEqual([
      "builds an index on attachments inside the migrator's transaction",
    ]);
    expect(
      problemsOf('-- purlay: no-transaction\nCREATE INDEX CONCURRENTLY i ON attachments (a);'),
    ).toEqual([]);
  });

  test('a column type change', () => {
    expect(problemsOf('ALTER TABLE audit_log ALTER COLUMN detail TYPE TEXT;')).toEqual([
      'changes the type of a column of audit_log, which rewrites it',
    ]);
    expect(
      problemsOf('ALTER TABLE audit_log ALTER COLUMN detail SET DATA TYPE TEXT;'),
    ).toHaveLength(1);
    expect(problemsOf('ALTER TABLE audit_log ALTER COLUMN detail SET DEFAULT 1;')).toEqual([]);
  });

  test('a statement that only defines a function is not one that runs', () => {
    expect(
      problemsOf(
        'CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN UPDATE messages SET x = 1; RETURN NEW; END; $$ LANGUAGE plpgsql;',
      ),
    ).toEqual([]);
  });

  test('an UPDATE inside a DO block is read too, and ON UPDATE of a key is not one', () => {
    expect(problemsOf('DO $$ BEGIN UPDATE messages SET x = 1; END $$;')).toHaveLength(1);
    expect(
      problemsOf('CREATE TABLE t (m UUID REFERENCES messages(id) ON UPDATE CASCADE);'),
    ).toEqual([]);
  });
});
