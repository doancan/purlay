/**
 * The cache the kill switch rests on (D-296): the hot path pays no query of its own, a change is believed within the TTL, one
 * read at a time is out however many ask, a read that fails keeps the stop that was on, and a change made here is not undone by
 * a read that began before it.
 */
import { describe, expect, test } from 'bun:test';
import { aRecordingLogger } from '../testing/doubles';
import { SUSPENSION_TTL_MS, noSuspension, suspensionCache } from './suspended-modules';

const set = (...ids: string[]): ReadonlySet<string> => new Set(ids);

const aCache = (
  initial: ReadonlySet<string> = set(),
): {
  cache: ReturnType<typeof suspensionCache>;
  reads: () => number;
  stored: { current: ReadonlySet<string>; fail: boolean; hold: Promise<void> | undefined };
  advance: (ms: number) => void;
  lines: Record<string, unknown>[];
} => {
  let clock = 0;
  let reads = 0;
  const stored = { current: initial, fail: false, hold: undefined as Promise<void> | undefined };
  const { log, lines } = aRecordingLogger();
  const cache = suspensionCache({
    read: async () => {
      reads += 1;
      const answer = stored.current;
      if (stored.hold !== undefined) await stored.hold;
      if (stored.fail) throw new Error('the database is away');
      return answer;
    },
    log,
    now: () => clock,
  });
  return {
    cache,
    reads: () => reads,
    stored,
    advance: (ms): void => {
      clock += ms;
    },
    lines,
  };
};

describe('the TTL is the contract', () => {
  test('is two seconds at most', () => {
    expect(SUSPENSION_TTL_MS).toBeLessThanOrEqual(2_000);
  });

  test('a node holds nothing before it has read, and reads once for any number of askers within the TTL', async () => {
    const { cache, reads, stored, advance } = aCache(set('issues'));
    expect(cache.current().size).toBe(0);
    expect([...(await cache.fresh())]).toEqual(['issues']);
    stored.current = set();
    advance(SUSPENSION_TTL_MS - 1);
    for (let asked = 0; asked < 50; asked += 1) await cache.fresh();
    expect(reads()).toBe(1);
    expect([...cache.current()]).toEqual(['issues']);
  });

  test('believes a change once the TTL has passed, in either direction', async () => {
    const { cache, reads, stored, advance } = aCache();
    await cache.fresh();
    stored.current = set('issues');
    advance(SUSPENSION_TTL_MS);
    expect([...(await cache.fresh())]).toEqual(['issues']);
    stored.current = set();
    advance(SUSPENSION_TTL_MS);
    expect((await cache.fresh()).size).toBe(0);
    expect(reads()).toBe(3);
  });

  test('has one read out at a time, however many ask while it is', async () => {
    const { cache, reads, stored } = aCache(set('chat'));
    let release: () => void = () => undefined;
    stored.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const askers = Promise.all([cache.fresh(), cache.fresh(), cache.fresh()]);
    release();
    const answers = await askers;
    expect(reads()).toBe(1);
    for (const answer of answers) expect([...answer]).toEqual(['chat']);
  });
});

describe('a read that fails', () => {
  test('keeps the set last read, says so once, and says when it can read again', async () => {
    const { cache, stored, advance, lines } = aCache(set('issues'));
    await cache.fresh();
    stored.fail = true;
    for (let round = 0; round < 3; round += 1) {
      advance(SUSPENSION_TTL_MS);
      expect([...(await cache.fresh())]).toEqual(['issues']);
    }
    expect(lines.filter((line) => line['level'] === 'warn')).toHaveLength(1);
    stored.fail = false;
    stored.current = set();
    advance(SUSPENSION_TTL_MS);
    expect((await cache.fresh()).size).toBe(0);
    expect(lines.some((line) => String(line['msg']).includes('can be read again'))).toBe(true);
  });

  test('is not retried before the TTL: a database that is away is not asked on every request', async () => {
    const { cache, reads, stored, advance } = aCache();
    stored.fail = true;
    await cache.fresh();
    for (let asked = 0; asked < 20; asked += 1) await cache.fresh();
    expect(reads()).toBe(1);
    advance(SUSPENSION_TTL_MS);
    await cache.fresh();
    expect(reads()).toBe(2);
  });
});

describe('a change made on this node', () => {
  test('is known at once, and a read that began before it does not undo it', async () => {
    const { cache, stored } = aCache(set());
    let release: () => void = () => undefined;
    stored.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reading = cache.fresh();
    cache.replace(set('issues'));
    expect([...cache.current()]).toEqual(['issues']);
    release();
    await reading;
    expect([...cache.current()]).toEqual(['issues']);
  });
});

describe('without a database', () => {
  test('nothing is ever stopped', async () => {
    expect(noSuspension.current().size).toBe(0);
    expect((await noSuspension.fresh()).size).toBe(0);
  });
});
