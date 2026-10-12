/**
 * The report that closes O-4 (#61): what it reads from the API's log, and what it answers.
 */
import { describe as group, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, reportOf, summarise } from './frame-report';

const closed = (peakPerSecond: number, frames: number, refused = 0): string =>
  JSON.stringify({
    level: 30,
    msg: 'socket closed',
    closeCode: 1000,
    frames,
    peakPerSecond,
    refused,
  });

group('the frame report', () => {
  test('reads every socket’s closing line, and the refusals of each kind', () => {
    const peaks = Array.from({ length: 100 }, (_, n) => closed(n + 1, 10));
    const report = summarise([
      ...peaks,
      closed(3, 5, 2),
      JSON.stringify({ msg: 'send refused: over the user write budget' }),
      JSON.stringify({ msg: 'request', status: 429, path: '/api/x' }),
      JSON.stringify({ msg: 'request', status: 200, path: '/api/x' }),
      'not json',
      '42',
      '',
    ]);
    expect(report).toEqual({
      sockets: 101,
      frames: 1005,
      peakP99: 99,
      peakMax: 100,
      framesRefused: 2,
      writesRefused: 1,
      httpRefused: 1,
      unreadable: 2,
    });
  });

  test('a week with no refusal and every peak inside the burst closes O-4; any refusal does not', () => {
    const quiet = describe(summarise([closed(4, 30), closed(12, 80)]));
    expect(quiet.at(-1)).toBe('O-4: legitimate use met no refusal, inside the burst');
    expect(quiet[1]).toBe(
      'peak frames in a second, p99: 12, max: 12 — the budget is 10/s with a burst of 20',
    );
    const refused = describe(summarise([closed(4, 30, 1)]));
    expect(refused.at(-1)).toBe(
      'O-4: something met the budget — read the refusals before closing it',
    );
    const over = describe(summarise([closed(25, 30)]));
    expect(over.at(-1)).toContain('something met the budget');
  });

  test('nothing measured says so, rather than a percentile of nothing', () => {
    expect(summarise([])).toMatchObject({ sockets: 0, peakP99: 0, peakMax: 0 });
    expect(describe(summarise(['x'])).at(-1)).toBe('lines that were not JSON, skipped: 1');
  });

  test('reads files, or standard input when it is given none', async () => {
    const file = join(tmpdir(), `frames-${crypto.randomUUID()}.log`);
    await Bun.write(file, `${closed(5, 9)}\n${closed(7, 1)}\n`);
    const unread = (): Promise<string> => Promise.reject(new Error('standard input was read'));
    expect((await reportOf([file], unread))[0]).toBe('sockets closed: 2, frames: 10');
    expect((await reportOf([], () => Promise.resolve(closed(1, 1))))[0]).toBe(
      'sockets closed: 1, frames: 1',
    );
  });
});
