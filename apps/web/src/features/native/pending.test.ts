import { describe, expect, test } from 'bun:test';
import { installDom } from '../../testing/dom';
import {
  captureNativeHandoff,
  forgetNativeHandoff,
  HANDOFF_TTL_MS,
  keepNativeHandoff,
  pendingNativeHandoff,
  type NativePorts,
} from './pending';

installDom();

const CHALLENGE = 'a'.repeat(43);
const STATE = 'b'.repeat(22);
const NOW = 1_800_000_000_000;

const ports = (
  options: { refuses?: boolean; now?: number } = {},
): NativePorts & { kept: Map<string, string>; urls: string[] } => {
  const kept = new Map<string, string>();
  const urls: string[] = [];
  return {
    kept,
    urls,
    storage: {
      getItem: (key): string | null => {
        if (options.refuses === true) throw new Error('blocked');
        return kept.get(key) ?? null;
      },
      setItem: (key, value): void => {
        if (options.refuses === true) throw new Error('blocked');
        kept.set(key, value);
      },
      removeItem: (key): void => {
        if (options.refuses === true) throw new Error('blocked');
        kept.delete(key);
      },
    },
    replace: (url): void => {
      urls.push(url);
    },
    now: (): number => options.now ?? NOW,
  };
};

const at = (search: string): { pathname: string; search: string } => ({
  pathname: '/sign-in/native',
  search,
});

describe('the native application’s challenge and state, as the page is opened with them', () => {
  test('leave the address as the page loads, and wait in the tab until they are used', () => {
    const p = ports();
    captureNativeHandoff(at(`?challenge=${CHALLENGE}&state=${STATE}`), p);
    expect(p.urls).toEqual(['/sign-in/native']);
    expect(pendingNativeHandoff(p, { search: '' })).toEqual({ challenge: CHALLENGE, state: STATE });
    forgetNativeHandoff(p);
    expect(pendingNativeHandoff(p, { search: '' })).toBeNull();
  });

  test('are kept as the page was given them and nothing else: an extra parameter is dropped', () => {
    const p = ports();
    captureNativeHandoff(
      at(`?challenge=${CHALLENGE}&state=${STATE}&redirect=https://evil.test`),
      p,
    );
    const stored = JSON.parse(p.kept.get('purlay.native') ?? '{}') as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(['at', 'challenge', 'state']);
  });

  test.each([
    ['another page', { pathname: '/w/acme', search: `?challenge=${CHALLENGE}&state=${STATE}` }],
    ['no challenge', at(`?state=${STATE}`)],
    ['no state', at(`?challenge=${CHALLENGE}`)],
    ['a challenge of 42 characters', at(`?challenge=${'a'.repeat(42)}&state=${STATE}`)],
    ['a state of 15 characters', at(`?challenge=${CHALLENGE}&state=${'b'.repeat(15)}`)],
    ['a state that is not base64url', at(`?challenge=${CHALLENGE}&state=${'b'.repeat(15)}%26x`)],
    [
      'a challenge given twice',
      at(`?challenge=${CHALLENGE}&challenge=${CHALLENGE}&state=${STATE}`),
    ],
    ['nothing', at('')],
  ])('%s is no handoff, and is left alone', (_name, location) => {
    const p = ports();
    captureNativeHandoff(location, p);
    expect(p.urls).toEqual([]);
    expect(p.kept.size).toBe(0);
  });

  test('wait ten minutes and not a second more: a tab left on a sign-in page for an hour is not asked', () => {
    const p = ports();
    captureNativeHandoff(at(`?challenge=${CHALLENGE}&state=${STATE}`), p);
    expect(
      pendingNativeHandoff({ ...p, now: () => NOW + HANDOFF_TTL_MS - 1 }, { search: '' }),
    ).not.toBeNull();
    expect(
      pendingNativeHandoff({ ...p, now: () => NOW + HANDOFF_TTL_MS }, { search: '' }),
    ).toBeNull();
    // And finding it stale forgets it, so a later look is not another chance.
    expect(p.kept.has('purlay.native')).toBe(false);
    expect(HANDOFF_TTL_MS).toBe(600_000);
  });

  test.each([
    ['not JSON', 'x{'],
    ['a string', JSON.stringify('x')],
    ['without a time', JSON.stringify({ challenge: CHALLENGE, state: STATE })],
    [
      'with a time from the future',
      JSON.stringify({ challenge: CHALLENGE, state: STATE, at: NOW + 60_000 }),
    ],
    [
      'with a time that is not a number',
      JSON.stringify({ challenge: CHALLENGE, state: STATE, at: 'now' }),
    ],
    [
      'with a challenge that is not the shape',
      JSON.stringify({ challenge: 'x', state: STATE, at: NOW }),
    ],
    [
      'with a state that is not the shape',
      JSON.stringify({ challenge: CHALLENGE, state: 'x&', at: NOW }),
    ],
  ])('what the tab holds that is %s is nothing', (_name, held) => {
    const p = ports();
    p.kept.set('purlay.native', held);
    expect(pendingNativeHandoff(p, { search: '' })).toBeNull();
  });

  test('a tab that cannot keep them leaves them in the address, where the screen still finds them', () => {
    const p = ports({ refuses: true });
    captureNativeHandoff(at(`?challenge=${CHALLENGE}&state=${STATE}`), p);
    expect(p.urls).toEqual([]);
    expect(pendingNativeHandoff(p, { search: `?challenge=${CHALLENGE}&state=${STATE}` })).toEqual({
      challenge: CHALLENGE,
      state: STATE,
    });
  });

  test('a tab that cannot be read, and an address with nothing, hold nothing', () => {
    expect(pendingNativeHandoff(ports({ refuses: true }), { search: '' })).toBeNull();
  });
});

describe('a pair that arrived another way — in a sign-in link’s fragment (D-191)', () => {
  test('is kept for this tab as one the page was opened with would be', () => {
    const p = ports();
    keepNativeHandoff({ challenge: CHALLENGE, state: STATE }, p);
    expect(pendingNativeHandoff(p, { search: '' })).toEqual({ challenge: CHALLENGE, state: STATE });
  });

  test('is not kept when it is not the shape', () => {
    const p = ports();
    keepNativeHandoff({ challenge: 'x', state: STATE }, p);
    keepNativeHandoff({ challenge: CHALLENGE, state: 'a&b' }, p);
    expect(p.kept.size).toBe(0);
  });

  test('is not kept by a tab that refuses, and says nothing', () => {
    expect(() => {
      keepNativeHandoff({ challenge: CHALLENGE, state: STATE }, ports({ refuses: true }));
    }).not.toThrow();
  });

  test('forgetting from a tab that refuses says nothing either', () => {
    expect(() => {
      forgetNativeHandoff(ports({ refuses: true }));
    }).not.toThrow();
  });
});
