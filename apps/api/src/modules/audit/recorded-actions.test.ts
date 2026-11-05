/**
 * Every action the trail names is written by some source file (D-26). A trial removed `recordAudit`
 * from a create path and every test still passed, because each test of an action asks only that the
 * action can be read back, not that the code that was meant to write it still does. This sweep reads
 * the production source for the two shapes an action is recorded in — `action: '…'` in the entry, and
 * `audit(context, '…', …)` where a feature builds its entries — so a call taken away leaves the action
 * named in `AUDIT_ACTIONS` and written by nobody, and the sweep says which.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUDIT_ACTIONS } from '@purlay/types';

const ROOT = join(import.meta.dir, '..', '..', '..', '..', '..');

/**
 * Actions that are named but that no source writes. Empty today: each is recorded. An action may
 * be listed here only with the reason it is reserved, so adding one is a decision a reviewer sees.
 */
const RESERVED = new Set<string>();

const sourceText = readdirSync(join(ROOT, 'apps/api/src'), { withFileTypes: true, recursive: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.includes('.test.'))
  .map((entry) => readFileSync(join(entry.parentPath, entry.name), 'utf8'))
  .join('\n');

/** `action: 'x'` but not the first of a union of types (`action: 'x' | 'y'`), and `audit(context, 'x'`. */
const isRecorded = (action: string): boolean => {
  const quoted = action.replaceAll('.', '\\.');
  return new RegExp(`\\baction:\\s*'${quoted}'(?!\\s*\\|)|\\baudit\\([^,()]+,\\s*'${quoted}'`).test(
    sourceText,
  );
};

describe('every audit action is recorded by the source', () => {
  test('the sweep recognises a recorded action and not an invented one', () => {
    expect(isRecorded('channel.created')).toBe(true);
    expect(isRecorded('issue.deleted')).toBe(true);
    expect(isRecorded('channel.invented')).toBe(false);
  });

  test('no action of the trail is written by nobody', () => {
    const unwritten = AUDIT_ACTIONS.filter(
      (action) => !RESERVED.has(action) && !isRecorded(action),
    );
    expect(unwritten).toEqual([]);
  });

  test('a reserved action is one the trail names and the source still does not write', () => {
    const stale = [...RESERVED].filter(
      (action) => !(AUDIT_ACTIONS as readonly string[]).includes(action) || isRecorded(action),
    );
    expect(stale).toEqual([]);
  });
});
