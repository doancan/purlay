/**
 * Search operators (D-224): what a typed line is read as, what it sets over what was chosen, what is
 * left as words and said, and when a search cannot be asked.
 */
import { describe, expect, test } from 'bun:test';
import { SEARCH_QUERY_MAX, SEARCH_QUERY_MIN, type Channel } from '@purlay/types';
import { createFormatters } from '../../i18n/format';
import {
  ALICE,
  BOB,
  IDS,
  NO_PROFILE,
  WHEN,
  aChannel,
  aUser,
  someChannels,
  someMembers,
} from '../../testing/fixtures';
import {
  asTyped,
  liftOperators,
  parseSearch,
  searchProblem,
  unreadOperators,
  type Directory,
  type SearchState,
} from './operators';

const GÜL = aUser('gül', '00000000-0000-4000-8000-0000000000f1');
const DIRECT = aChannel(IDS.dm, null, { type: 'direct_message', peer: BOB, peers: [BOB] });
const GROUP: Channel = aChannel('00000000-0000-4000-8000-0000000000f2', null, {
  type: 'direct_message',
  peer: null,
  peers: [ALICE, BOB],
});
const TURKISH = aChannel('00000000-0000-4000-8000-0000000000f3', 'istanbul-ekibi');

const directory = (timeZone = 'UTC'): Directory => ({
  channels: [...someChannels(), DIRECT, GROUP, TURKISH],
  members: [...someMembers(), { role: 'member', joinedAt: WHEN, profile: NO_PROFILE, user: GÜL }],
  meId: IDS.me,
  dayStart: createFormatters('en', timeZone).dayStart,
});

const NOTHING: SearchState = { words: '', channelId: null, authorId: null, filters: {} };
const lift = (text: string, base: SearchState = NOTHING, zone?: string): SearchState =>
  liftOperators(text, base, directory(zone));

describe('reading a line', () => {
  test('words and operators, in the order typed', () => {
    expect(parseSearch('in:#api deploy from:@alice  failed')).toEqual([
      { kind: 'operator', key: 'in', value: '#api', token: 'in:#api' },
      { kind: 'words', text: 'deploy' },
      { kind: 'operator', key: 'from', value: '@alice', token: 'from:@alice' },
      { kind: 'words', text: 'failed' },
    ]);
  });

  test('nothing, or only spaces, is nothing', () => {
    expect(parseSearch('')).toEqual([]);
    expect(parseSearch(' \t\n ')).toEqual([]);
  });

  test('keys ignore case, and every Turkish i is the one letter', () => {
    const keys = parseSearch('IN:#api İS:open ıs:resolved Has:code FROM:me').map((part) =>
      part.kind === 'operator' ? part.key : part.text,
    );
    expect(keys).toEqual(['in', 'is', 'is', 'has', 'from']);
  });

  test('an unknown key, a link, a time and a bare colon are words', () => {
    expect(parseSearch('foo:bar a:b https://example.com/x 10:30 : :x')).toEqual(
      ['foo:bar', 'a:b', 'https://example.com/x', '10:30', ':', ':x'].map((text) => ({
        kind: 'words',
        text,
      })),
    );
  });

  test('an empty value is still an operator, to be said as unread', () => {
    expect(parseSearch('from:')).toEqual([
      { kind: 'operator', key: 'from', value: '', token: 'from:' },
    ]);
  });

  test('a value keeps the colons after the first', () => {
    expect(parseSearch('repo:a:b')).toEqual([
      { kind: 'operator', key: 'repo', value: 'a:b', token: 'repo:a:b' },
    ]);
  });

  test('a quoted phrase is words, without its quotes, operators in it included', () => {
    expect(parseSearch('"is:open in:#api"  "deploy  failed" "" "  "')).toEqual([
      { kind: 'words', text: 'is:open in:#api' },
      { kind: 'words', text: 'deploy  failed' },
    ]);
    expect(parseSearch('say"hi"')).toEqual([{ kind: 'words', text: 'say"hi"' }]);
  });

  test('a quote with no partner is a character like any other', () => {
    expect(parseSearch('"oops is:open')).toEqual([
      { kind: 'words', text: '"oops' },
      { kind: 'operator', key: 'is', value: 'open', token: 'is:open' },
    ]);
  });

  test('Unicode and emoji are words as they are', () => {
    expect(parseSearch('çay şöyle 🚀 İstanbul')).toEqual(
      ['çay', 'şöyle', '🚀', 'İstanbul'].map((text) => ({ kind: 'words', text })),
    );
  });
});

describe('what a line sets', () => {
  test('every operator lands on the filter its control sets, and the rest are the words', () => {
    expect(
      lift('in:#api from:@alice has:code is:resolved repo:Acme/API deploy on:2026-10-31 "is:open"'),
    ).toEqual({
      words: 'deploy is:open',
      channelId: IDS.api,
      authorId: IDS.alice,
      filters: {
        kind: 'code',
        status: 'resolved',
        repository: 'Acme/API',
        since: '2026-10-31T00:00:00.000Z',
        until: '2026-11-01T00:00:00.000Z',
      },
    });
  });

  test('the remaining flags', () => {
    expect(lift('has:file is:question is:open').filters).toEqual({
      kind: 'file',
      question: 'yes',
      status: 'open',
    });
    expect(lift('has:FILES').filters).toEqual({ kind: 'file' });
  });

  test('a channel by name with or without #, any case and marks; a direct message by @person', () => {
    expect(lift('in:api').channelId).toBe(IDS.api);
    expect(lift('in:#DEPLOYS').channelId).toBe(IDS.deploys);
    expect(lift('in:#İstanbul-Ekibi').channelId).toBe(TURKISH.id);
    expect(lift('in:@bob').channelId).toBe(IDS.dm);
    // A group is not one person's conversation.
    expect(lift('in:@alice').channelId).toBeNull();
  });

  test('a person by username, with or without @, any case and marks; me is whoever is signed in', () => {
    expect(lift('from:BOB').authorId).toBe(IDS.bob);
    expect(lift('from:@gul').authorId).toBe(GÜL.id);
    expect(lift('from:me').authorId).toBe(IDS.me);
  });

  test('the last of a kind wins, and an operator wins over what was chosen', () => {
    const chosen: SearchState = {
      words: 'old words',
      channelId: IDS.deploys,
      authorId: IDS.bob,
      filters: { status: 'open', question: 'yes' },
    };
    expect(lift('is:open is:resolved in:#api fix', chosen)).toEqual({
      words: 'fix',
      channelId: IDS.api,
      authorId: IDS.bob,
      filters: { status: 'resolved', question: 'yes' },
    });
  });

  test('days are the viewer’s: after is from the next day, before ends at the day, on is the day', () => {
    expect(lift('after:2026-10-01 before:2026-10-31', NOTHING, 'Europe/Istanbul').filters).toEqual({
      since: '2026-10-01T21:00:00.000Z',
      until: '2026-10-30T21:00:00.000Z',
    });
    expect(lift('on:2026-03-08', NOTHING, 'America/New_York').filters).toEqual({
      since: '2026-03-08T05:00:00.000Z',
      until: '2026-03-09T04:00:00.000Z',
    });
    // Across a year's end.
    expect(lift('on:2026-12-31').filters).toEqual({
      since: '2026-12-31T00:00:00.000Z',
      until: '2027-01-01T00:00:00.000Z',
    });
  });

  test('what cannot be read stays in the words, where it was typed', () => {
    const unread = [
      'in:#nowhere',
      'in:@nobody',
      'in:#',
      'from:@nobody',
      'from:@',
      'from:',
      'has:pictures',
      'is:closed',
      'repo:not-a-repository',
      'repo:a:b',
      'before:2026-02-30',
      'after:31-10-2026',
      'on:1969-12-31',
      'on:9999-01-01',
      'on:',
    ];
    for (const token of unread) {
      expect(lift(`find ${token} this`)).toEqual({ ...NOTHING, words: `find ${token} this` });
    }
  });
});

describe('what is said about the words', () => {
  test('each operator that could not be read, with why', () => {
    expect(
      unreadOperators('in:#nowhere from:@nobody has:pictures from: deploy', directory()),
    ).toEqual([
      { token: 'in:#nowhere', value: '#nowhere', why: 'channel' },
      { token: 'from:@nobody', value: '@nobody', why: 'person' },
      { token: 'has:pictures', value: 'pictures', why: 'value' },
      { token: 'from:', value: '', why: 'value' },
    ]);
  });

  test('one that could be read was quoted on purpose, and is not said; nor are plain words', () => {
    expect(unreadOperators('is:open foo:bar deploy', directory())).toEqual([]);
  });
});

describe('the words as the field shows them', () => {
  test('an operator that would be read is quoted; one that would not, and words, stay bare', () => {
    expect(asTyped('deploy is:open in:#nowhere foo:bar', directory())).toBe(
      'deploy "is:open" in:#nowhere foo:bar',
    );
  });

  test('read again, the field asks for the same words and sets nothing', () => {
    for (const words of ['deploy is:open', 'in:#api from:me', 'in:#nowhere x', 'çay a"b']) {
      expect(lift(asTyped(words, directory()))).toEqual({ ...NOTHING, words });
    }
  });
});

describe('when a search cannot be asked', () => {
  const state = (words: string, over: Partial<SearchState> = {}): SearchState => ({
    ...NOTHING,
    words,
    ...over,
  });

  test('too few characters, or nothing at all with no filter', () => {
    expect(searchProblem(state(''))).toBe('tooShort');
    expect(searchProblem(state('a'.repeat(SEARCH_QUERY_MIN - 1)))).toBe('tooShort');
    expect(searchProblem(state('a'.repeat(SEARCH_QUERY_MIN)))).toBeNull();
  });

  test('a filter stands alone without words, but not beside too few', () => {
    expect(searchProblem(state('', { channelId: IDS.api }))).toBeNull();
    expect(searchProblem(state('', { authorId: IDS.bob }))).toBeNull();
    expect(searchProblem(state('', { filters: { kind: 'code' } }))).toBeNull();
    expect(searchProblem(state('ab', { filters: { kind: 'code' } }))).toBe('tooShort');
  });

  test('more than the server takes', () => {
    expect(searchProblem(state('a'.repeat(SEARCH_QUERY_MAX)))).toBeNull();
    expect(searchProblem(state('a'.repeat(SEARCH_QUERY_MAX + 1)))).toBe('tooLong');
  });

  test('an end that does not follow the start', () => {
    expect(searchProblem(lift('after:2026-10-05 before:2026-10-01'))).toBe('range');
    expect(searchProblem(lift('after:2026-10-01 before:2026-10-02'))).toBe('range');
    expect(searchProblem(lift('after:2026-10-01 before:2026-10-03'))).toBeNull();
  });
});
