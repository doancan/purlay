/**
 * Guards the move of an attachment's link to its message out of the core (D-250, `MODULES.md` §10, step 9).
 *
 * `attachments.message_id` and `attachments.channel_id` are still written, for one release, so that the release
 * before this one finds what it reads. Nothing in this one may READ them: the core asks `claimed_at` whether an
 * upload is sent, and chat asks `message_attachments` which message and channel a file is in. A production
 * query that names either column on `attachments` fails here, however it is spelled — qualified
 * (`attachments.message_id`), or bare in a statement that selects from, deletes from or updates `attachments`.
 *
 * The allow-list is the one place that WRITES the old columns, the dual write of the link. The exports name the
 * columns as data in their catalogues, which this does not match. In the contract release the columns are
 * dropped, the dual write goes, and the allow-list shrinks to nothing.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** `apps/api/src`: the core's modules, the platform, the features and the rest are all read. */
const ROOT = join(import.meta.dir, '../../..');

/** Where the old columns may still be named, and why. Empty after the contract release. */
const WRITES_THE_OLD_COLUMNS: Readonly<Record<string, string>> = {
  'features/chat/messages/messages.ts':
    'linkAttachments sets message_id and channel_id (the dual write)',
};

const sources = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.ts') && !entry.name.includes('.test.') ? [path] : [];
  });

/** A column of `attachments`, named with its table. */
const QUALIFIED = /\battachments\.(message_id|channel_id)\b/;

/** A statement on `attachments`: the query builder's or raw SQL's, up to the end of the statement. */
const STATEMENT_ON_ATTACHMENTS =
  /(?:(?:selectFrom|deleteFrom|updateTable)\(\s*'attachments'[^;]*|\b(?:from|into|update)\s+attachments\b[^;`]*)/g;

/** The `where` of the export's table of attachments, which follows the table's columns. */
const EXPORT_BOUND_ON_ATTACHMENTS = /tableExport\(\s*'attachments'[\s\S]*?where:\s*sql`([^`]*)`/g;

/** The columns, bare or quoted, but not another table's (`messages.channel_id`, `message_attachments.message_id`). */
const BARE = /(?<![.\w])['"]?(message_id|channel_id)\b/;

/** Production code that reads the old columns, as `path: text` lines. */
const readsOldColumns = (path: string, text: string): string[] => {
  const found: string[] = [];
  if (QUALIFIED.test(text)) found.push(`${path}: names attachments.message_id / channel_id`);
  // An export's own table of attachments says how it is bounded in a `where`, after naming its columns as data.
  for (const bound of text.matchAll(EXPORT_BOUND_ON_ATTACHMENTS)) {
    if (BARE.test(bound[1] ?? ''))
      found.push(`${path}: the export of attachments is bounded by message_id / channel_id`);
  }
  for (const statement of text.matchAll(STATEMENT_ON_ATTACHMENTS)) {
    if (BARE.test(statement[0]))
      found.push(`${path}: a statement on attachments names message_id / channel_id`);
  }
  return found;
};

describe('readers of an attachment’s link to its message', () => {
  test('none reads attachments.message_id or attachments.channel_id', () => {
    const offenders = sources(ROOT)
      .map((path) => ({ path: path.slice(ROOT.length + 1), text: readFileSync(path, 'utf8') }))
      .filter(({ path }) => !(path in WRITES_THE_OLD_COLUMNS))
      .flatMap(({ path, text }) => readsOldColumns(path, text));
    expect(offenders).toEqual([]);
  });

  test('the allow-list is only what still writes them', () => {
    for (const path of Object.keys(WRITES_THE_OLD_COLUMNS)) {
      expect(readsOldColumns(path, readFileSync(join(ROOT, path), 'utf8')).length).toBeGreaterThan(
        0,
      );
    }
  });

  test('the scan can tell: it finds each way of reading, and not the link', () => {
    const reads = (text: string): number => readsOldColumns('x.ts', text).length;
    expect(reads(".whereRef('attachments.message_id', '=', 'messages.id')")).toBe(1);
    expect(
      reads("transaction.selectFrom('attachments').select('id').where('message_id', 'is', null)"),
    ).toBe(1);
    expect(reads("db.deleteFrom('attachments').where('channel_id', '=', id)")).toBe(1);
    expect(reads('select uploader_id from attachments where message_id in (1)')).toBe(1);
    expect(
      reads("executor.selectFrom('attachments').where('claimed_at', 'is', null).execute();"),
    ).toBe(0);
    expect(
      reads(
        "tableExport('attachments', { message_id: 'export' }, (s) => ({ where: sql`message_id in (1)`, order: 'id' }))",
      ),
    ).toBe(1);
    expect(
      reads(
        "executor.selectFrom('attachments').select(sql`sum(size_bytes)`.as('b')).where('message_id', 'is', null)",
      ),
    ).toBe(1);
    expect(reads("selectFrom('message_attachments').where('message_id', 'in', ids)")).toBe(0);
    expect(
      reads("selectFrom('attachments').innerJoin('messages', 'messages.channel_id', 'x')"),
    ).toBe(0);
  });
});
