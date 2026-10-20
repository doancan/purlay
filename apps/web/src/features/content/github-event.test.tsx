/**
 * A repository's event, drawn (#79, D-134 §6): what each kind says in both languages, and every link
 * built from the event's parts — a branch with a slash and a tag with a `#` reach the right page.
 */
import { describe, expect, test } from 'bun:test';
import type { GitHubEvent } from '@purlay/types';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { renderApp } from '../../testing/render';
import { createTranslate } from '../../i18n/translate';
import { en } from '../../i18n/catalogue/en';
import { tr } from '../../i18n/catalogue/tr';
import { eventSentence, GitHubEventCard, useMessageText } from './github-event';

installDom();

const SHA = (c: string): string => c.repeat(40);
const base = { repository: 'acme/api', actor: 'octocat' } as const;
const push = (over: Partial<Extract<GitHubEvent, { kind: 'push' }>> = {}): GitHubEvent => ({
  kind: 'push',
  ...base,
  ref: { type: 'branch', name: 'main' },
  change: 'pushed',
  before: SHA('a'),
  after: SHA('b'),
  commits: [{ sha: SHA('b'), title: 'Retry with jitter' }],
  commitCount: 1,
  ...over,
});

const t = createTranslate('en', en);

describe('what an event says', () => {
  test.each([
    [push(), 'octocat pushed 1 commit to main'],
    [push({ commitCount: 3 }), 'octocat pushed 3 commits to main'],
    [push({ change: 'forced' }), 'octocat force-pushed main'],
    [push({ change: 'created', commits: [], commitCount: 0 }), 'octocat created the branch main'],
    [push({ change: 'deleted', commits: [], commitCount: 0 }), 'octocat deleted the branch main'],
    [
      push({ change: 'created', ref: { type: 'tag', name: 'v1.2' }, commits: [], commitCount: 0 }),
      'octocat created the tag v1.2',
    ],
    [
      push({ change: 'deleted', ref: { type: 'tag', name: 'v1.2' }, commits: [], commitCount: 0 }),
      'octocat deleted the tag v1.2',
    ],
    [
      { kind: 'pull_request', ...base, action: 'opened', number: 7, title: 'x' } as const,
      'octocat opened pull request #7',
    ],
    [
      { kind: 'pull_request', ...base, action: 'ready_for_review', number: 7, title: 'x' } as const,
      'octocat marked pull request #7 ready for review',
    ],
    [
      { kind: 'issues', ...base, action: 'reopened', number: 9, title: 'x' } as const,
      'octocat reopened issue #9',
    ],
    [
      { kind: 'release', ...base, tag: 'v2.0.0', name: 'Two', prerelease: false } as const,
      'octocat published the release Two',
    ],
    [
      { kind: 'release', ...base, tag: 'v2.0.0-rc1', name: 'RC', prerelease: true } as const,
      'octocat published the pre-release RC',
    ],
    [
      { kind: 'release', ...base, tag: 'v2.0.0', name: '', prerelease: false } as const,
      'octocat published the release v2.0.0',
    ],
  ] satisfies [GitHubEvent, string][])('%#: %s', (event, said) => {
    expect(eventSentence(event, t)).toBe(said);
  });

  test('in Turkish, in Turkish', () => {
    const turkish = createTranslate('tr', tr);
    expect(eventSentence(push({ commitCount: 3 }), turkish)).toBe(
      'octocat, main üzerine 3 commit gönderdi',
    );
    expect(
      eventSentence(
        { kind: 'pull_request', ...base, action: 'merged', number: 7, title: 'x' },
        turkish,
      ),
    ).toBe('octocat, #7 numaralı pull request’i birleştirdi');
  });
});

describe('an event drawn', () => {
  const links = (view: Awaited<ReturnType<typeof renderApp>>): [string, string | null][] =>
    view.getAllByRole('link').map((link) => [link.textContent, link.getAttribute('href')]);

  test('a push: the comparison, each commit, what is not listed, and the repository', async () => {
    const view = await renderApp(
      <GitHubEventCard
        event={push({
          ref: { type: 'branch', name: 'feat/retry #2' },
          commits: [
            { sha: SHA('c'), title: 'Second' },
            { sha: SHA('b'), title: 'First' },
          ],
          commitCount: 7,
        })}
      />,
    );
    expect(links(view)).toEqual([
      [
        'octocat pushed 7 commits to feat/retry #2',
        `https://github.com/acme/api/compare/${'a'.repeat(12)}...${'b'.repeat(12)}`,
      ],
      ['ccccccc', `https://github.com/acme/api/commit/${SHA('c')}`],
      ['bbbbbbb', `https://github.com/acme/api/commit/${SHA('b')}`],
      ['acme/api', 'https://github.com/acme/api'],
    ]);
    expect(view.getByText('and 5 more commits')).toBeDefined();
    await expectNoAxeViolations(view.container);
    view.unmount();
  });

  test('a branch made links to the branch, each segment encoded; a release to its tag', async () => {
    const made = await renderApp(
      <GitHubEventCard
        event={push({
          change: 'created',
          ref: { type: 'branch', name: 'feat/retry #2' },
          commits: [],
          commitCount: 0,
        })}
      />,
    );
    expect(links(made)[0]?.[1]).toBe('https://github.com/acme/api/tree/feat/retry%20%232');
    made.unmount();
    const release = await renderApp(
      <GitHubEventCard
        event={{ kind: 'release', ...base, tag: 'v1/rc#1', name: 'RC', prerelease: true }}
      />,
    );
    expect(links(release)[0]?.[1]).toBe('https://github.com/acme/api/releases/tag/v1/rc%231');
    expect(release.getByText('RC')).toBeDefined();
    release.unmount();
  });

  test('an issue: its sentence links to it, its title beneath', async () => {
    const view = await renderApp(
      <GitHubEventCard
        event={{ kind: 'issues', ...base, action: 'opened', number: 9, title: 'Flaky retry' }}
      />,
    );
    expect(links(view)[0]).toEqual([
      'octocat opened issue #9',
      'https://github.com/acme/api/issues/9',
    ]);
    expect(view.getByText('Flaky retry')).toBeDefined();
    view.unmount();
  });

  test('a list shows a person’s words, and an event’s sentence', async () => {
    const said: string[] = [];
    const Probe = (): null => {
      const textOf = useMessageText();
      said.push(textOf({ content: 'hello', githubEvent: null }));
      said.push(textOf({ content: 'summary', githubEvent: push() }));
      return null;
    };
    const view = await renderApp(<Probe />);
    expect(said.slice(0, 2)).toEqual(['hello', 'octocat pushed 1 commit to main']);
    view.unmount();
  });
});
