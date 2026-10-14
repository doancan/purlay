/**
 * GitHub's push, read into what a feed posts (D-134 §6), and a delivery's signature checked: GitHub's
 * own published example, the bytes as sent rather than the JSON they mean, and every malformed header.
 */
import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import {
  GITHUB_EVENT_TEXT_MAX,
  PUSH_COMMITS_LISTED_MAX,
  PUSH_COMMITS_SHOWN_MAX,
} from '@purlay/types';
import { bounded, readDelivery, summaryOf } from './github-events';
import { signedBy } from './webhook';

const sha = (c: string): string => c.repeat(40);
const envelope = {
  repository: { id: 42, full_name: 'Acme/API' },
  sender: { login: 'octocat' },
};
const aPush = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...envelope,
  ref: 'refs/heads/main',
  before: sha('a'),
  after: sha('b'),
  created: false,
  deleted: false,
  forced: false,
  commits: [
    { id: sha('1'), message: 'First\n\nwith a body' },
    { id: sha('2'), message: 'Second' },
  ],
  // GitHub sends far more; none of it is kept.
  head_commit: { url: 'https://evil.test' },
  ...over,
});

describe('a push, read', () => {
  test('the newest commits first, each by its first line; the repository as GitHub names it', () => {
    expect(readDelivery('push', aPush(), ['push'])).toEqual({
      kind: 'event',
      envelope,
      event: {
        kind: 'push',
        repository: 'Acme/API',
        actor: 'octocat',
        ref: { type: 'branch', name: 'main' },
        change: 'pushed',
        before: sha('a'),
        after: sha('b'),
        commits: [
          { sha: sha('2'), title: 'Second' },
          { sha: sha('1'), title: 'First' },
        ],
        commitCount: 2,
      },
    });
  });

  test.each([
    [{ deleted: true, commits: [] }, 'deleted'],
    [{ created: true }, 'created'],
    [{ forced: true }, 'forced'],
    [{ created: true, forced: true }, 'created'],
  ] as const)('%o is %s', (over, change) => {
    const reading = readDelivery('push', aPush(over), ['push']);
    expect(reading.kind === 'event' && reading.event.kind === 'push' && reading.event.change).toBe(
      change,
    );
  });

  test('a tag is a tag; a ref that is neither is not a push a channel hears about', () => {
    const tag = readDelivery('push', aPush({ ref: 'refs/tags/v1.2.0' }), ['push']);
    expect(tag.kind === 'event' && tag.event.kind === 'push' && tag.event.ref).toEqual({
      type: 'tag',
      name: 'v1.2.0',
    });
    expect(readDelivery('push', aPush({ ref: 'refs/notes/commits' }), ['push']).kind).toBe(
      'ignored',
    );
  });

  test('bounded: the five newest of every commit listed, and a first line cut with an ellipsis', () => {
    const commits = Array.from({ length: 25 }, (_, n) => ({
      id: sha(String(n % 10)),
      message: n === 24 ? 'x'.repeat(GITHUB_EVENT_TEXT_MAX + 50) : `commit ${String(n)}`,
    }));
    const reading = readDelivery('push', aPush({ commits }), ['push']);
    if (reading.kind !== 'event' || reading.event.kind !== 'push') throw new Error('not a push');
    expect(reading.event.commits).toHaveLength(PUSH_COMMITS_SHOWN_MAX);
    expect(reading.event.commitCount).toBe(25);
    const title = reading.event.commits[0]?.title ?? '';
    expect(Array.from(title)).toHaveLength(GITHUB_EVENT_TEXT_MAX);
    expect(title.endsWith('…')).toBe(true);
    expect(reading.event.commits[1]?.title).toBe('commit 23');
  });

  test('more commits than GitHub lists is not GitHub’s push', () => {
    const commits = Array.from({ length: PUSH_COMMITS_LISTED_MAX + 1 }, () => ({
      id: sha('1'),
      message: 'x',
    }));
    expect(readDelivery('push', aPush({ commits }), ['push']).kind).toBe('invalid');
  });

  test('an enterprise’s managed login, and a long branch name, are a push like any other', () => {
    const reading = readDelivery(
      'push',
      aPush({ sender: { login: 'alice_acme' }, ref: `refs/heads/${'b'.repeat(1024)}` }),
      ['push'],
    );
    expect(reading.kind).toBe('event');
  });

  test('an event no feed posts may name no repository: ignored, never a failure', () => {
    expect(readDelivery('installation', { action: 'created' }, ['push'])).toEqual({
      kind: 'ignored',
      envelope: null,
    });
    expect(readDelivery('ping', { zen: 'Design for failure.', hook_id: 1 }, ['push'])).toEqual({
      kind: 'ignored',
      envelope: null,
    });
  });

  test('an event this feed does not post, or no feed posts, is ignored with what it names', () => {
    expect(readDelivery('push', aPush(), ['issues'])).toEqual({ kind: 'ignored', envelope });
    expect(
      readDelivery('ping', { ...envelope, zen: 'Keep it logically awesome.' }, ['push']),
    ).toEqual({ kind: 'ignored', envelope });
    expect(readDelivery('workflow_run', aPush(), ['push'])).toEqual({ kind: 'ignored', envelope });
  });

  test('a body without what its event must hold is invalid, never half read', () => {
    for (const body of [
      null,
      'a string',
      { sender: envelope.sender },
      { ...envelope, repository: { id: 0, full_name: 'acme/api' } },
      aPush({ before: 'abc' }),
      aPush({ commits: [{ id: sha('1') }] }),
      aPush({ ref: '' }),
      aPush({ sender: { login: 'not a login' } }),
      aPush({ repository: { id: 42, full_name: 'acme/..' } }),
    ]) {
      expect({ body, kind: readDelivery('push', body, ['push']).kind }).toEqual({
        body,
        kind: 'invalid',
      });
    }
  });

  test.each([
    [
      { kind: 'pull_request', action: 'merged', number: 7, title: 'Retry' },
      'octocat merged pull request #7 in acme/api: Retry',
    ],
    [
      { kind: 'issues', action: 'opened', number: 9, title: 'Flaky' },
      'octocat opened issue #9 in acme/api: Flaky',
    ],
    [
      { kind: 'release', tag: 'v2', name: 'Two', prerelease: false },
      'octocat published release Two (v2) in acme/api',
    ],
    [
      { kind: 'release', tag: 'v3-rc1', name: '', prerelease: true },
      'octocat published pre-release v3-rc1 in acme/api',
    ],
  ] as const)('the other kinds are found by their words too: %o', (parts, said) => {
    expect(summaryOf({ repository: 'acme/api', actor: 'octocat', ...parts })).toBe(said);
  });

  test('what search finds is its sentence and its commits, in English', () => {
    const reading = readDelivery('push', aPush(), ['push']);
    if (reading.kind !== 'event') throw new Error('not an event');
    expect(summaryOf(reading.event)).toBe('octocat pushed branch main in Acme/API\nSecond\nFirst');
  });
});

describe('a pull request, an issue and a release, read', () => {
  const all = ['push', 'pull_request', 'issues', 'release'] as const;
  const pr = (action: string, merged = false): Record<string, unknown> => ({
    ...envelope,
    action,
    number: 7,
    pull_request: { title: 'Retry with jitter', merged, body: 'never kept' },
  });

  test.each([
    ['opened', false, 'opened'],
    ['closed', false, 'closed'],
    ['closed', true, 'merged'],
    ['reopened', false, 'reopened'],
    ['ready_for_review', false, 'ready_for_review'],
  ] as const)('a pull request %s (merged: %s) is %s', (action, merged, said) => {
    expect(readDelivery('pull_request', pr(action, merged), all)).toEqual({
      kind: 'event',
      envelope,
      event: {
        kind: 'pull_request',
        repository: 'Acme/API',
        actor: 'octocat',
        action: said,
        number: 7,
        title: 'Retry with jitter',
      },
    });
  });

  test('a draft opened is not announced; its being ready for review is', () => {
    const draft = (action: string): Record<string, unknown> => ({
      ...envelope,
      action,
      number: 7,
      pull_request: { title: 'Retry', merged: false, draft: true },
    });
    expect(readDelivery('pull_request', draft('opened'), all).kind).toBe('ignored');
    expect(readDelivery('pull_request', draft('ready_for_review'), all).kind).toBe('event');
  });

  test('merged not yet known is null: an action is still read, and a close is a close', () => {
    const unknown = (action: string): Record<string, unknown> => ({
      ...envelope,
      action,
      number: 7,
      pull_request: { title: 'Retry', merged: null },
    });
    expect(readDelivery('pull_request', unknown('labeled'), all).kind).toBe('ignored');
    const closed = readDelivery('pull_request', unknown('closed'), all);
    expect(
      closed.kind === 'event' && closed.event.kind === 'pull_request' && closed.event.action,
    ).toBe('closed');
  });

  test('what a channel does not hear about is received and not posted', () => {
    for (const [name, body] of [
      ['pull_request', pr('labeled')],
      ['pull_request', pr('synchronize')],
      ['issues', { ...envelope, action: 'edited', issue: { number: 9, title: 'x' } }],
      [
        'release',
        {
          ...envelope,
          action: 'created',
          release: { tag_name: 'v1', name: null, prerelease: false },
        },
      ],
    ] as const) {
      expect({ name, kind: readDelivery(name, body, all).kind }).toEqual({ name, kind: 'ignored' });
    }
  });

  test.each(['opened', 'closed', 'reopened'] as const)('an issue %s is posted', (action) => {
    const reading = readDelivery(
      'issues',
      { ...envelope, action, issue: { number: 9, title: 'Flaky' } },
      all,
    );
    expect(
      reading.kind === 'event' && reading.event.kind === 'issues' && reading.event.action,
    ).toBe(action);
  });

  test('an issue deleted or moved elsewhere is not posted (D-134 §1)', () => {
    for (const action of ['deleted', 'transferred', 'pinned', 'labeled']) {
      const body = { ...envelope, action, issue: { number: 9, title: 'x' } };
      expect({ action, kind: readDelivery('issues', body, all).kind }).toEqual({
        action,
        kind: 'ignored',
      });
    }
  });

  test('an issue opened, closed and reopened; its title cut to its bound', () => {
    const long = 'y'.repeat(GITHUB_EVENT_TEXT_MAX + 10);
    const reading = readDelivery(
      'issues',
      { ...envelope, action: 'closed', issue: { number: 9, title: long } },
      all,
    );
    if (reading.kind !== 'event' || reading.event.kind !== 'issues') throw new Error('no issue');
    expect([reading.event.action, reading.event.number]).toEqual(['closed', 9]);
    expect(Array.from(reading.event.title)).toHaveLength(GITHUB_EVENT_TEXT_MAX);
  });

  const release = (action: string, name: string | null, prerelease = false): unknown => ({
    ...envelope,
    action,
    release: { tag_name: 'v2.0.0', name, prerelease },
  });

  test('a release is heard of once: released or prereleased, never published beside it', () => {
    expect(readDelivery('release', release('released', 'Two'), all)).toMatchObject({
      kind: 'event',
      event: { kind: 'release', tag: 'v2.0.0', name: 'Two', prerelease: false },
    });
    expect(readDelivery('release', release('prereleased', null, true), all)).toMatchObject({
      kind: 'event',
      event: { kind: 'release', name: '', prerelease: true },
    });
    for (const action of ['published', 'created', 'edited', 'deleted', 'unpublished']) {
      expect({ action, kind: readDelivery('release', release(action, 'x'), all).kind }).toEqual({
        action,
        kind: 'ignored',
      });
    }
  });

  test('a body without what its event must hold is invalid', () => {
    for (const [name, body] of [
      ['pull_request', { ...envelope, action: 'opened', number: 7 }],
      ['issues', { ...envelope, action: 'opened', issue: { number: 0, title: 'x' } }],
      [
        'release',
        {
          ...envelope,
          action: 'released',
          release: { tag_name: '', name: 'x', prerelease: false },
        },
      ],
      ['release', { ...envelope, action: 'released', release: { tag_name: 'v1', name: 'x' } }],
      [
        'pull_request',
        { action: 'opened', number: 7, pull_request: { title: 'x', merged: false } },
      ],
    ] as const) {
      expect({ name, kind: readDelivery(name, body, all).kind }).toEqual({ name, kind: 'invalid' });
    }
  });
});

describe('a line cut to its bound', () => {
  test('counts as the contract counts, and never splits a character that takes two', () => {
    const emoji = '😀';
    const fits = emoji.repeat(GITHUB_EVENT_TEXT_MAX / 2);
    expect(bounded(fits)).toBe(fits);
    const cut = bounded(`${fits}${emoji}`);
    expect(cut.length).toBeLessThanOrEqual(GITHUB_EVENT_TEXT_MAX);
    expect(cut.endsWith(`${emoji}…`)).toBe(true);
    // One unit short of a whole emoji at the end: the emoji goes, never half of it.
    const odd = bounded(`a${fits}`);
    expect(odd.length).toBeLessThanOrEqual(GITHUB_EVENT_TEXT_MAX);
    expect(/[\uD800-\uDBFF]…$/.test(odd)).toBe(false);
  });

  test('an issue titled with emoji past the bound is posted, never refused as GitHub’s fault', () => {
    const reading = readDelivery(
      'issues',
      { ...envelope, action: 'opened', issue: { number: 9, title: '😀'.repeat(200) } },
      ['issues'],
    );
    expect(reading.kind).toBe('event');
  });
});

describe('a delivery’s signature', () => {
  test('GitHub’s published example holds', () => {
    // docs.github.com, "Validating webhook deliveries".
    expect(
      signedBy(
        "It's a Secret to Everybody",
        new TextEncoder().encode('Hello, World!'),
        'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17',
      ),
    ).toBe(true);
  });

  test('is over the bytes as sent: the same JSON written otherwise does not hold', () => {
    const sent = new TextEncoder().encode('{"a": "\\u00e9", "b": "\\/"}');
    const header = `sha256=${createHmac('sha256', 's').update(sent).digest('hex')}`;
    expect(signedBy('s', sent, header)).toBe(true);
    const reserialised = new TextEncoder().encode(
      JSON.stringify(JSON.parse('{"a": "\\u00e9", "b": "\\/"}')),
    );
    expect(signedBy('s', reserialised, header)).toBe(false);
  });

  test('anything but the exact header is refused, never thrown', () => {
    const body = new TextEncoder().encode('{}');
    const hex = createHmac('sha256', 's').update(body).digest('hex');
    expect(signedBy('s', body, `sha256=${hex}`)).toBe(true);
    for (const header of [
      null,
      '',
      hex,
      `sha1=${hex}`,
      `sha256=${hex.toUpperCase()}`,
      `sha256=${hex.slice(2)}`,
      `sha256=${hex}00`,
      `sha256=${hex.replace(/.$/, 'z')}`,
      `sha256=${createHmac('sha256', 'another').update(body).digest('hex')}`,
    ]) {
      expect({ header, holds: signedBy('s', body, header) }).toEqual({ header, holds: false });
    }
  });
});
