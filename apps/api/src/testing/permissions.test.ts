/**
 * The permission table is complete: every endpoint `API.md` serves (○) whose caller column names a
 * role is in it, and every endpoint it names is one `API.md` documents. A role-gated endpoint added
 * without its cases fails here, before anyone has to remember the matrix (CONTRIBUTING §6.2).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PERMISSIONS } from './permissions';

const API = readFileSync(
  fileURLToPath(new URL('../../../../docs/API.md', import.meta.url)),
  'utf8',
);
const ROW =
  /^\|\s*([○①②③])\s*\|\s*`(GET|POST|PUT|PATCH|DELETE)`\s*\|\s*`(\/api\/[^`]+)`\s*\|\s*([^|]*)\|/;

const rows = API.split('\n').flatMap((line) => {
  const match = ROW.exec(line);
  return match === null
    ? []
    : [
        {
          served: match[1] === '○',
          key: `${match[2] ?? ''} ${match[3] ?? ''}`,
          who: match[4] ?? '',
        },
      ];
});

describe('the permission table', () => {
  test('reads API.md, so it is not checking an empty list', () => {
    expect(rows.filter((row) => row.served).length).toBeGreaterThan(20);
  });

  test('has cases for every served endpoint gated by a role', () => {
    const covered = new Set(Object.values(PERMISSIONS).map((entry) => entry.endpoint));
    const gated = rows
      .filter((row) => row.served && /^\s*(admin|owner)\b/.test(row.who))
      .map((row) => row.key);
    expect(gated.length).toBeGreaterThan(0);
    expect(gated.filter((key) => !covered.has(key))).toEqual([]);
  });

  test('names only endpoints API.md documents as served', () => {
    const served = new Set(rows.filter((row) => row.served).map((row) => row.key));
    const unknown = Object.values(PERMISSIONS)
      .map((entry) => entry.endpoint)
      .filter((key) => !served.has(key));
    expect(unknown).toEqual([]);
  });
});
