/**
 * The numbers the documents state, against the constants that enforce them.
 *
 * A reader of `API.md` or `ARCHITECTURE.md` should not have to open the code to
 * learn the page cap or the socket's limits, so the documents say them — and a
 * number in two places is a number that will disagree with itself (#201). The
 * code owns each one; this fails when a document stops matching it.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { TABLE_LIFECYCLE } from '@purlay/db';
import { MAX_FRAME_BYTES, PAGE_LIMIT } from '@purlay/types';
import { STARVATION_FACTOR } from './cli/budget-latency';
import { SOCKET_FRAME_BUDGET } from './realtime/rate-limiter';

/** As prose: a line break in Markdown is a space, and rewrapping a paragraph changes nothing. */
const prose = (path: string): string => readFileSync(path, 'utf8').replace(/\s+/g, ' ');
const api = prose('docs/API.md');
const architecture = prose('docs/ARCHITECTURE.md');
const modules = prose('docs/MODULES.md');

const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
];

/** The number a test file gives a cap constant, read from its text: the file is a test, so it cannot be imported. */
const capIn = (file: string, name: string): number => {
  const found = new RegExp(`const ${name} = (\\d+);`).exec(readFileSync(file, 'utf8'));
  if (found?.[1] === undefined) throw new Error(`${file} has no \`const ${name} = <number>;\``);
  return Number(found[1]);
};

describe('numbers the documents state', () => {
  test('API.md states the page cap and default the contract enforces', () => {
    expect(api).toContain(
      `capped at ${String(PAGE_LIMIT.max)} (default ${String(PAGE_LIMIT.default)})`,
    );
  });

  test('ARCHITECTURE.md §5.5 states the frame cap the contract enforces', () => {
    expect(architecture).toContain(`Max frame size ${String(MAX_FRAME_BYTES / 1024)} KB`);
  });

  test('ARCHITECTURE.md §5.5 states the rate budget the limiter enforces', () => {
    expect(architecture).toContain(
      `${String(SOCKET_FRAME_BUDGET.perSecond)} frames/second with a burst of ${String(SOCKET_FRAME_BUDGET.burst)}`,
    );
  });

  test('MODULES.md states the starvation factor of the latency gate', () => {
    expect(modules).toContain(
      `more than ${NUMBER_WORDS[STARVATION_FACTOR] ?? '?'} times** that (\`STARVATION_FACTOR\``,
    );
  });

  test('MODULES.md §9 states the caps of the lists that only shrink, as the tests hold them', () => {
    const unindexed = capIn('packages/db/src/query-columns.integration.test.ts', 'MAX_UNINDEXED');
    expect(modules).toContain(
      `${NUMBER_WORDS[unindexed] ?? '?'} reasoned exceptions, capped at ${String(unindexed)}`,
    );
    const grandfathered = capIn('packages/db/src/migration-safety.test.ts', 'MAX_GRANDFATHERED');
    expect(modules).toContain(
      `${NUMBER_WORDS[grandfathered] ?? '?'} shipped files grandfathered with a reason, capped at ${String(grandfathered)}`,
    );
    const unseeded = capIn('apps/api/src/table-lifecycle.integration.test.ts', 'MAX_UNSEEDED_KEPT');
    const anonymised = Object.values(TABLE_LIFECYCLE).filter(
      ({ erasure }) => erasure === 'anonymised',
    ).length;
    expect(modules).toContain(
      `(all ${String(anonymised)}; the allow-list of unprobed tables is empty and capped at ${String(unseeded)})`,
    );
  });
});
