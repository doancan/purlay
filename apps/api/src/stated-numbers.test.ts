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
import { MAX_FRAME_BYTES, PAGE_LIMIT } from '@purlay/types';
import { SOCKET_FRAME_BUDGET } from './realtime/rate-limiter';

/** As prose: a line break in Markdown is a space, and rewrapping a paragraph changes nothing. */
const prose = (path: string): string => readFileSync(path, 'utf8').replace(/\s+/g, ' ');
const api = prose('docs/API.md');
const architecture = prose('docs/ARCHITECTURE.md');

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
});
