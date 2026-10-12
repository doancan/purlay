/**
 * GitHub cards under a message's words (#67, `ARCHITECTURE.md` §8.3): what a card says, which links
 * become one and how many, and that a link with no card — none from the server, a failure — is left
 * a link with nothing drawn.
 */
import { describe, expect, test } from 'bun:test';
import { act } from '@testing-library/react';
import type { GitHubCardMetadata } from '@purlay/types';
import { GITHUB_LINKS_PER_MESSAGE_MAX } from '@purlay/types';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { IDS, aSignedInApi } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import type { Api } from '../../data/api';
import { SessionGate } from '../session/session';
import { WorkspaceScopeProvider } from '../shell/workspace';
import { GitHubCards } from './github-cards';

installDom();

const PR = 'https://github.com/purlay/purlay/pull/42';
const ISSUE = 'https://github.com/purlay/purlay/issues/7';

const card = (over: Partial<GitHubCardMetadata> = {}): GitHubCardMetadata => ({
  type: 'pr',
  repo: 'purlay/purlay',
  number: 42,
  title: 'Keyset pagination for threads',
  state: 'merged',
  author: { login: 'octocat', avatarUrl: 'https://avatars.githubusercontent.com/u/1' },
  ...over,
});

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const show = async (
  content: string,
  unfurl: Api['unfurl'],
  locale: 'en' | 'tr' = 'en',
): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  const view = await renderApp(
    <SessionGate>
      <WorkspaceScopeProvider slug="acme" notFound={null}>
        <GitHubCards content={content} />
      </WorkspaceScopeProvider>
    </SessionGate>,
    { api: aSignedInApi({ unfurl }), locale },
  );
  await settle();
  return view;
};

const cards = (view: Awaited<ReturnType<typeof renderApp>>): HTMLElement[] =>
  Array.from(view.container.querySelectorAll<HTMLElement>('[data-github-card]'));

describe('GitHub cards', () => {
  test('a pull request: its repository and number, its state, its title as a link out, who opened it', async () => {
    const asked: [string, string][] = [];
    const view = await show(`see ${PR}`, async (workspaceId, url) => {
      asked.push([workspaceId, url]);
      return await Promise.resolve(card());
    });
    expect(asked).toEqual([[IDS.workspace, PR]]);
    const [only] = cards(view);
    expect(only?.textContent).toContain('purlay/purlay#42');
    expect(only?.textContent).toContain('Merged');
    expect(only?.textContent).toContain('Pull request by octocat');
    const title = view.getByRole('link', { name: 'Keyset pagination for threads' });
    expect(title.getAttribute('href')).toBe(PR);
    expect(title.getAttribute('target')).toBe('_blank');
    expect(title.getAttribute('rel')).toBe('noopener noreferrer');
    // GitHub's avatar is another host's image: drawing it would tell GitHub who is reading (#110).
    expect(view.container.querySelector('img')).toBeNull();
    await expectNoAxeViolations(view.container);
  });

  test('several links are several cards, in the order written; one link twice is one request', async () => {
    const asked: string[] = [];
    const view = await show(`${ISSUE} then ${PR} and ${ISSUE} again`, async (_workspace, url) => {
      asked.push(url);
      return await Promise.resolve(
        url === ISSUE
          ? card({ type: 'issue', number: 7, title: 'Typing is slow', state: 'open' })
          : card(),
      );
    });
    expect(asked).toEqual([ISSUE, PR]);
    expect(cards(view).map((c) => c.textContent.includes('#7'))).toEqual([true, false]);
    expect(cards(view)[0]?.textContent).toContain('Issue by octocat');
  });

  test('no more links are asked about than a message records', async () => {
    const links = Array.from(
      { length: GITHUB_LINKS_PER_MESSAGE_MAX + 2 },
      (_, n) => `https://github.com/purlay/purlay/pull/${String(n + 1)}`,
    );
    let asked = 0;
    await show(links.join(' '), async () => {
      asked += 1;
      return await Promise.resolve(null);
    });
    expect(asked).toBe(GITHUB_LINKS_PER_MESSAGE_MAX);
  });

  test('no card from the server, or a request that failed: nothing is drawn, the words stand', async () => {
    const none = await show(`see ${PR}`, () => Promise.resolve(null));
    expect(cards(none)).toEqual([]);
    const failed = await show(`see ${PR}`, () =>
      Promise.reject(new ApiError(0, 'NETWORK', 'down')),
    );
    expect(cards(failed)).toEqual([]);
  });

  test('words that link to no pull request or issue ask nothing', async () => {
    const view = await show('see https://github.com/purlay/purlay and https://example.test', () => {
      throw new Error('asked');
    });
    expect(cards(view)).toEqual([]);
  });

  test('the state is said in Turkish when the interface is', async () => {
    const view = await show(`bkz. ${PR}`, () => Promise.resolve(card({ state: 'closed' })), 'tr');
    expect(cards(view)[0]?.textContent).toContain('Kapalı');
  });

  test('a pull request’s checks and reviews are said in words, each only when GitHub said it (#423)', async () => {
    const view = await show(`see ${PR}`, () =>
      Promise.resolve(
        card({ state: 'open', ciStatus: 'failure', reviewDecision: 'changes_requested' }),
      ),
    );
    const text = cards(view)[0]?.textContent ?? '';
    expect(text).toContain('Checks failed');
    expect(text).toContain('Changes requested');
    const plain = await show(`see ${PR}`, () => Promise.resolve(card()));
    expect(cards(plain)[0]?.textContent).not.toMatch(/Checks|Approved|Review/);
  });

  test.each([
    ['success', 'approved', 'Kontroller geçti', 'Onaylandı'],
    ['pending', 'review_required', 'Kontroller sürüyor', 'İnceleme bekliyor'],
  ] as const)(
    'checks %s and review %s, in Turkish',
    async (ciStatus, reviewDecision, ci, review) => {
      const view = await show(
        `bkz. ${PR}`,
        () => Promise.resolve(card({ ciStatus, reviewDecision })),
        'tr',
      );
      const text = cards(view)[0]?.textContent ?? '';
      expect(text).toContain(ci);
      expect(text).toContain(review);
    },
  );
});
