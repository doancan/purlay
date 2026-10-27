/**
 * The frame budget against what a page sends (O-4, D-198): every legitimate profile passes with room,
 * the flood does not, and the numbers that must move together do.
 */
import { describe, expect, test } from 'bun:test';
import { OUTBOX_MAX_MESSAGES, SUBSCRIBE_MAX_CHANNELS } from '@purlay/types';
import { WRITE_BUDGET } from '../ingress/http/rate-limit';
import { FRAME_QUEUE_MAX } from './hub';
import { measure, measureAll, profiles, table, type Measured } from './frame-profiles';
import { SOCKET_FRAME_BUDGET } from './rate-limiter';

/** What D-66 shipped with, before D-198. */
const PROVISIONAL = { perSecond: 10, burst: 20 } as const;

const named = (rows: readonly Measured[], part: string): Measured => {
  const row = rows.find((r) => r.name.includes(part));
  if (row === undefined) throw new Error(`no profile named like ${part}`);
  return row;
};

describe('the frame budget, against what a page sends', () => {
  test('no legitimate profile is refused, a frame or a send', async () => {
    const rows = await measureAll(SOCKET_FRAME_BUDGET, WRITE_BUDGET);
    const refused = rows.filter((r) => r.legitimate && (r.refused > 0 || r.writesRefused > 0));
    expect(refused.map((r) => r.name)).toEqual([]);
    expect(rows.filter((r) => r.legitimate).length).toBeGreaterThanOrEqual(10);
  });

  test('with room: the sustained rate and the burst each keep a margin over the worst profile', async () => {
    const rows = (await measureAll(SOCKET_FRAME_BUDGET, WRITE_BUDGET)).filter((r) => r.legitimate);
    // A burst is held to the instant the frames leave in; the rate to a second of them.
    const worstBurst = Math.max(...rows.map((r) => r.burst));
    expect(SOCKET_FRAME_BUDGET.burst - worstBurst).toBeGreaterThanOrEqual(5);
    // Over a second a person's own frames stay below the rate; what exceeds it is a burst, which the
    // bucket's tokens carry (the rows above show none refused).
    const sustained = rows.filter((r) => !/outbox|resubscribe/.test(r.name));
    expect(Math.max(...sustained.map((r) => r.peakPerSecond))).toBeLessThan(
      SOCKET_FRAME_BUDGET.perSecond,
    );
  });

  test('a flood is still refused: the burst is a bound, not an opening', async () => {
    const rows = await measureAll(SOCKET_FRAME_BUDGET, WRITE_BUDGET);
    const flood = named(rows, 'flood');
    expect(flood.refused).toBe(flood.frames - SOCKET_FRAME_BUDGET.burst);
  });

  test('a full outbox sent on reconnect fits, and the number it fits is why the burst is sixty', async () => {
    const rows = await measureAll(SOCKET_FRAME_BUDGET, WRITE_BUDGET);
    const full = named(rows, 'full outbox');
    expect(full.burst).toBeGreaterThan(OUTBOX_MAX_MESSAGES);
    expect(full.refused).toBe(0);
    expect(full.writesRefused).toBe(0);
  });

  test('the budget D-66 shipped with refuses a full outbox: the measurement is what moved it', async () => {
    const rows = await measureAll(PROVISIONAL, PROVISIONAL);
    expect(named(rows, 'full outbox').refused).toBeGreaterThan(0);
    expect(named(rows, '3,500 channels, 20 ms').refused).toBeGreaterThan(0);
  });

  test('the user write bucket refuses too, when the connection bucket would have let the sends through', async () => {
    const all = await profiles(SOCKET_FRAME_BUDGET);
    const outbox = all.find((p) => p.name.includes('full outbox'));
    if (outbox === undefined) throw new Error('no outbox profile');
    const generous = { perSecond: 10, burst: 100 };
    const row = await measure(outbox, generous, { perSecond: 10, burst: 20 });
    expect(row.refused).toBe(0);
    expect(row.writesRefused).toBe(OUTBOX_MAX_MESSAGES - 20);
  });

  test('a subscription of 3,500 channels is 35 chunks, each inside the burst however fast it is answered', async () => {
    const rows = await measureAll(SOCKET_FRAME_BUDGET, WRITE_BUDGET);
    const fast = named(rows, '3,500 channels, 5 ms');
    expect(fast.frames).toBe(Math.ceil(3_500 / SUBSCRIBE_MAX_CHANNELS));
    expect(fast.refused).toBe(0);
  });

  test('the connection holds as many waiting frames as the bucket lets in at once', () => {
    expect(FRAME_QUEUE_MAX).toBeGreaterThan(SOCKET_FRAME_BUDGET.burst);
  });

  test('the write budget is the socket budget: the two doors to a send cost the same', () => {
    expect(WRITE_BUDGET).toEqual(SOCKET_FRAME_BUDGET);
  });

  test('the table names every profile and the budget it ran under', async () => {
    const rows = await measureAll(SOCKET_FRAME_BUDGET, WRITE_BUDGET);
    const lines = table(rows, SOCKET_FRAME_BUDGET);
    expect(lines[0]).toBe(
      `budget: ${String(SOCKET_FRAME_BUDGET.perSecond)}/s, burst ${String(SOCKET_FRAME_BUDGET.burst)}`,
    );
    expect(lines).toHaveLength(rows.length + 2);
  });
});
