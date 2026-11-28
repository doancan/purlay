/**
 * `core.member-left` is published in the transaction that deletes a membership, on every path that does (D-355, `MODULES.md` §4).
 * A path that deleted the row and said nothing would leave a module holding what the person can no longer reach, which no
 * consumer can see: so this reads the production source for each place that deletes from `workspace_members` and holds it to
 * the call that tells the modules, or to a reason written here why it need not.
 *
 * It is a scan for the delete as text, so it sees the query builder and a raw statement and not a delete built from a variable.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';
import { coreSources, shown } from './testing/module-sources';

const DELETES_A_MEMBERSHIP =
  /deleteFrom\(\s*['"`]workspace_members['"`]\s*\)|delete\s+from\s+workspace_members\b/i;
const TELLS_THE_MODULES = /\bdepartures\(/;

/** The places that delete a membership and tell no module, each with why that is right. */
const EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    'modules/workspaces/deletion-purge.ts',
    'the purge removes the whole workspace, and every module emptied its tables for it in the same transaction',
  ],
]);

const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('the paths that end a membership', () => {
  test('finds a delete of a membership, as the query builder writes it or as a statement', () => {
    expect(DELETES_A_MEMBERSHIP.test(".deleteFrom('workspace_members')")).toBe(true);
    expect(DELETES_A_MEMBERSHIP.test('.deleteFrom( "workspace_members" )')).toBe(true);
    expect(DELETES_A_MEMBERSHIP.test('DELETE FROM workspace_members WHERE user_id = $1')).toBe(
      true,
    );
    expect(DELETES_A_MEMBERSHIP.test(".deleteFrom('workspace_member_roles')")).toBe(false);
    expect(DELETES_A_MEMBERSHIP.test(".selectFrom('workspace_members')")).toBe(false);
  });

  test('every production file that deletes a membership tells the modules, or is excepted with a reason', () => {
    const untold: string[] = [];
    const deleting: string[] = [];
    for (const file of coreSources([])) {
      const source = withoutComments(readFileSync(file, 'utf8'));
      if (!DELETES_A_MEMBERSHIP.test(source)) continue;
      const path = shown(file);
      deleting.push(path);
      if (!EXEMPT.has(path) && !TELLS_THE_MODULES.test(source)) untold.push(path);
    }
    expect(untold).toEqual([]);
    // An exception for a file that no longer deletes a membership is a reason nobody can check.
    expect([...EXEMPT.keys()].filter((path) => !deleting.includes(path))).toEqual([]);
  });
});
