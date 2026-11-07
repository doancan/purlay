/**
 * The core names no table a module owns (D-250, `MODULES.md` §4, §10 step 10): `modules/` and `platform/` — the code
 * that must run with every module absent — and the doors, `cli/`, `ingress/` and `realtime/`, reach a module's rows
 * through a port or a contribution the module supplies, never by writing the table's name in a query. The tables are read from `TABLE_OWNERS`, the one list of
 * who owns what, so a table a module gains is covered without this file being told.
 *
 * What is looked for is a table in a place a query puts one (a builder method's first argument, SQL's `from`,
 * `join`, `into`, `update`, a column written `table.column`, an index into the schema type, `tableExists`), not
 * every word: `/api/channels` is a path and `messages` a field in plenty of code. Comments are stripped first, as
 * the keyset check of `enforcement.test.ts` does. The core's tests are not held to this: they build a room in chat
 * and read its rows (the lint lets them import a feature).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { TABLE_OWNERS } from '@purlay/db';

const SOURCE_ROOT = import.meta.dir;
const CORE_DIRECTORIES = ['modules', 'platform', 'cli', 'ingress', 'realtime'] as const;

/**
 * A file of the core that may still name a module's table, with why and who answers for the follow-up. **It may only
 * shrink**: an entry whose file no longer names one fails the test, and `MAX_ALLOWED` holds its size.
 */
const ALLOWED: Readonly<Record<string, string>> = {
  'cli/budget-latency.ts':
    'the latency gate locks `issues` and `messages` in turns and measures chat’s send path and issues’ list, through the demo world it seeds',
  'cli/demo-seed.ts': 'the demo world is made of chat’s channels and issues’ rows',
};

/**
 * The size `ALLOWED` may have. The list is a seam that is not a port yet and only shrinks, but a test of "an entry still
 * needs it" cannot see an entry being added: this can. A file joins the list only with this raised in the same change,
 * which is a line a reviewer reads and has to accept.
 */
const MAX_ALLOWED = 2;

const moduleTables = Object.entries(TABLE_OWNERS)
  .filter(([, owner]) => owner !== 'core')
  .map(([table]) => table)
  .sort((a, b) => b.length - a.length);

const BUILDER_METHODS =
  'selectFrom|insertInto|deleteFrom|updateTable|mergeInto|with|innerJoin|leftJoin|rightJoin|fullJoin|crossJoin|innerJoinLateral|leftJoinLateral|crossJoinLateral';

/** The ways a statement names one of `tables`: the builder's methods, SQL's keywords, `table.column`, the schema type, `tableExists`. */
const waysToName = (tables: readonly string[]): readonly RegExp[] => {
  const names = `(?:${tables.join('|')})`;
  return [
    new RegExp(String.raw`\.(?:${BUILDER_METHODS})\(\s*['"\`]${names}\b`),
    new RegExp(
      String.raw`\b(?:from|join|into|update|truncate|table)\s+(?:only\s+)?(?:public\.)?${names}\b`,
      'i',
    ),
    new RegExp(String.raw`['"\`]${names}\.[a-z_*]+['"\`]`),
    new RegExp(String.raw`\b(?:Database|DB)\[\s*['"]${names}['"]\s*\]`),
    new RegExp(String.raw`\btableExists\(\s*[^,()]+,\s*['"]${names}['"]`),
  ];
};

const WAYS_TO_NAME_A_TABLE = waysToName(moduleTables);
const WAYS_TO_NAME_THE_OUTBOX = waysToName(['outbox']);

const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/** The first way `source` names a table by `ways`, as the text it matched; none when it names none. */
const tableNamed = (
  source: string,
  ways: readonly RegExp[] = WAYS_TO_NAME_A_TABLE,
): string | undefined => {
  const code = withoutComments(source);
  for (const way of ways) {
    const found = way.exec(code);
    if (found !== null) return found[0];
  }
  return undefined;
};

const coreSources = (): string[] =>
  CORE_DIRECTORIES.flatMap((directory) =>
    readdirSync(join(SOURCE_ROOT, directory), { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .map((file) => join(directory, file)),
  ).sort();

describe('the core names no table a module owns', () => {
  test('the tables come from the owners list, and the files from the core', () => {
    expect(moduleTables).toContain('messages');
    expect(moduleTables).toContain('notifications');
    expect(moduleTables).not.toContain('users');
    expect(coreSources()).toContain(join('modules', 'push', 'sender.ts'));
    expect(coreSources()).toContain(join('platform', 'clock.ts'));
    for (const door of ['cli', 'ingress', 'realtime']) {
      expect(coreSources().some((file) => file.startsWith(`${door}/`))).toBe(true);
    }
  });

  test('it sees a table in each place a query puts one, and nothing in a path or a field', () => {
    for (const named of [
      "db.selectFrom('notifications as n')",
      "db.insertInto('link_previews').values(row)",
      'db\n  .deleteFrom(`link_previews`)',
      "q.innerJoin('channels as c', 'c.id', 'n.channel_id')",
      'await sql`delete from messages where id = ${id}`',
      'sql`select 1 from public.reactions`',
      "eb.ref('channel_members.user_id')",
      "type Row = Database['mentions'];",
      "await tableExists(transaction, 'message_attachments')",
    ]) {
      expect(tableNamed(named)).toBeDefined();
    }
    for (const unnamed of [
      "'/api/channels/:channelId/messages'",
      "const RESERVED = new Set(['channels', 'messages', 'notifications']);",
      "// .selectFrom('messages') in a comment",
      '/* delete from channels */ const x = 1;',
      "db.selectFrom('users').innerJoin('workspaces as w', 'w.id', 'users.id')",
      'const done = { messages: 0 }; done.messages += 1;',
      "await tableExists(transaction, 'object_deletions')",
    ]) {
      expect(tableNamed(unnamed)).toBeUndefined();
    }
  });

  for (const file of coreSources()) {
    if (file in ALLOWED) continue;
    test(`${file} names none`, () => {
      expect(tableNamed(readFileSync(join(SOURCE_ROOT, file), 'utf8'))).toBeUndefined();
    });
  }

  test('the list is no longer than its cap', () => {
    expect(Object.keys(ALLOWED).length).toBeLessThanOrEqual(MAX_ALLOWED);
  });

  test('an allowed file still needs it, so the list only shrinks', () => {
    for (const file of Object.keys(ALLOWED)) {
      expect(tableNamed(readFileSync(join(SOURCE_ROOT, file), 'utf8'))).toBeDefined();
    }
  });
});

/**
 * The core's inbox is written through the `NotificationSink` and nowhere else a module can reach (D-286): a module's
 * files name `inbox_entries` neither in a query nor in a type, so a notice is never one a module wrote around the sink's
 * checks of the kind, the recipient and the size. The module's own handle does not hold the table either (`CORE_READS`).
 */
describe('no module names the core’s inbox', () => {
  const featureSources = (): string[] =>
    readdirSync(join(SOURCE_ROOT, 'features'), { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .map((file) => join('features', file))
      .sort();

  test('the files looked at are the modules’', () => {
    expect(featureSources()).toContain(join('features', 'issues', 'issues.ts'));
  });

  for (const file of featureSources()) {
    test(`${file} does not`, () => {
      expect(withoutComments(readFileSync(join(SOURCE_ROOT, file), 'utf8'))).not.toContain(
        'inbox_entries',
      );
    });
  }
});

/**
 * The outbox is the core's, and only the files that write and read it name it (D-288): a module that wrote a fact's row
 * itself would skip the owner, the schema and the transaction check of `publishFact`, and one that read it would see another
 * module's facts. The tables a module may name are typed (`IssuesSchema`), which keeps a module out; this keeps the rest of the core.
 */
describe('only the outbox’s own files name the outbox', () => {
  const OUTBOX_FILES = [join('platform', 'outbox.ts')];

  test('it sees the table in each place a query puts one, and nothing in a word', () => {
    for (const named of [
      "db.insertInto('outbox').values(row)",
      'await sql`update outbox set state = ${state}`',
      "q.deleteFrom('outbox')",
      "eb.ref('outbox.consumer')",
    ]) {
      expect(tableNamed(named, WAYS_TO_NAME_THE_OUTBOX)).toBeDefined();
    }
    for (const unnamed of [
      'const outbox = createOutbox(mail);',
      "log.warn('the mail outbox is full')",
      '// db.insertInto("outbox") in a comment',
    ]) {
      expect(tableNamed(unnamed, WAYS_TO_NAME_THE_OUTBOX)).toBeUndefined();
    }
  });

  test('the file that does is where it is said to be', () => {
    for (const file of OUTBOX_FILES) {
      expect(
        tableNamed(readFileSync(join(SOURCE_ROOT, file), 'utf8'), WAYS_TO_NAME_THE_OUTBOX),
      ).toBeDefined();
    }
  });

  for (const file of coreSources().filter((one) => !OUTBOX_FILES.includes(one))) {
    test(`${file} does not`, () => {
      expect(
        tableNamed(readFileSync(join(SOURCE_ROOT, file), 'utf8'), WAYS_TO_NAME_THE_OUTBOX),
      ).toBeUndefined();
    });
  }
});
