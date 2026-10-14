/**
 * GitHub's push, read into what a feed posts (D-134 §6), and a delivery's signature checked: GitHub's
 * own published example, the bytes as sent rather than the JSON they mean, and every malformed header.
 */
import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { GITHUB_EVENT_TEXT_MAX, PUSH_COMMITS_SHOWN_MAX } from '@purlay/types';
import { readDelivery, summaryOf } from './github-events';
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

  test('bounded: the five newest of twenty, and a first line cut with an ellipsis', () => {
    const commits = Array.from({ length: 25 }, (_, n) => ({
      id: sha(String(n % 10)),
      message: n === 24 ? 'x'.repeat(GITHUB_EVENT_TEXT_MAX + 50) : `commit ${String(n)}`,
    }));
    const reading = readDelivery('push', aPush({ commits }), ['push']);
    if (reading.kind !== 'event' || reading.event.kind !== 'push') throw new Error('not a push');
    expect(reading.event.commits).toHaveLength(PUSH_COMMITS_SHOWN_MAX);
    expect(reading.event.commitCount).toBe(20);
    const title = reading.event.commits[0]?.title ?? '';
    expect(Array.from(title)).toHaveLength(GITHUB_EVENT_TEXT_MAX);
    expect(title.endsWith('…')).toBe(true);
    expect(reading.event.commits[1]?.title).toBe('commit 23');
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

  test('what search finds is its sentence and its commits, in English', () => {
    const reading = readDelivery('push', aPush(), ['push']);
    if (reading.kind !== 'event') throw new Error('not an event');
    expect(summaryOf(reading.event)).toBe('octocat pushed branch main in Acme/API\nSecond\nFirst');
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
