/**
 * The browser never calls the public `GET /api/client` (D-248). That route is charged to the client's address
 * with the sign-in traffic; a page that asks it on every load spends the budget people sign in with. It is for the
 * native applications, which ask it once, before anybody has signed in. The version a signed-in page needs comes
 * with `GET /api/releases/latest`.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCES = readdirSync(join(import.meta.dir, '../..'), { recursive: true, encoding: 'utf8' })
  .filter((path) => /\.tsx?$/.test(path))
  .filter((path) => !/\.test\.tsx?$/.test(path) && !path.startsWith('testing/'))
  .map((path) => ({ path, text: readFileSync(join(import.meta.dir, '../..', path), 'utf8') }));

describe('the client’s sources', () => {
  test('were read, so an empty list is not a pass', () => {
    expect(SOURCES.length).toBeGreaterThan(200);
  });

  test('never name the public client-info route as an address to ask', () => {
    const asking = SOURCES.filter(({ text }) => /['"`]\/api\/client\/?['"`]/.test(text)).map(
      ({ path }) => path,
    );
    expect(asking).toEqual([]);
  });
});
