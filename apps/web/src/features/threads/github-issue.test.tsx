/**
 * A thread's GitHub work and making an issue from it (D-246 §2, §4), through the real providers: nothing is
 * drawn where the workspace has no installation in use, the person's own authorization is asked for when it is
 * missing, the review shows the destination and the exact text before Create, the request keeps its id while
 * GitHub's answer is not known and gets a new one when the words change, and each outcome is said in words.
 */
import { describe, expect, test } from 'bun:test';
import { within } from '@testing-library/react';
import {
  githubIssueMarker,
  type CreateGitHubIssueRequest,
  type GitHubAppStatus,
  type GitHubIssueOutcome,
  type GitHubWorkLink,
} from '@purlay/types';
import type { Api } from '../../data/api';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { aMessage, aSignedInApi, WHEN } from '../../testing/fixtures';
import { settle } from '../../testing/channel-harness';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { SessionGate } from '../session/session';
import { leave } from '../sign-in/leave';
import { WorkspaceScopeProvider } from '../shell/workspace';
import { GitHubWorkPanel } from './github-issue';

installDom();

const INSTALLATION = {
  accountLogin: 'acme',
  accountType: 'Organization',
  suspended: false,
  connectedAt: WHEN,
} as const;
const READY: GitHubAppStatus = {
  available: true,
  installation: INSTALLATION,
  authorization: { login: 'ayse-dev' },
};
const UNAUTHORISED: GitHubAppStatus = { ...READY, authorization: null };
const REPOSITORIES = {
  repositories: [
    { id: 77, fullName: 'acme/api', private: true },
    { id: 78, fullName: 'acme/web', private: false },
  ],
};
const LINK: GitHubWorkLink = {
  id: '0194a000-0000-7000-8000-000000000001',
  repository: 'acme/api',
  kind: 'issue',
  number: 12,
  title: 'Retry with jitter',
  state: 'open',
  origin: 'created',
  url: 'https://github.com/acme/api/issues/12',
};

const summary = { replyCount: 1, lastReplyAt: WHEN, resolvedAt: null, resolvedBy: null };

const mount = async (options: {
  readonly status?: GitHubAppStatus;
  readonly api?: Partial<Api>;
  readonly work?: readonly GitHubWorkLink[];
  readonly member?: boolean;
  readonly isPublic?: boolean;
  readonly knowledge?: boolean;
}): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  const root = aMessage(1, {
    content: 'How should the retry back off?',
    thread: {
      ...summary,
      ...(options.work === undefined ? {} : { githubWork: [...options.work] }),
      ...(options.knowledge === true
        ? {
            knowledge: {
              version: 1,
              isQuestion: true,
              assigneeId: null,
              acceptedAnswer: { id: aMessage(2).id, content: 'Exponential.' },
              decisionNote: 'Use jitter',
              decisionUrl: null,
            },
          }
        : {}),
    },
  });
  const view = await renderApp(
    <SessionGate>
      <WorkspaceScopeProvider slug="acme" notFound={null}>
        <GitHubWorkPanel
          root={root}
          member={options.member ?? true}
          channelIsPublic={options.isPublic ?? true}
        />
      </WorkspaceScopeProvider>
    </SessionGate>,
    {
      api: aSignedInApi({
        githubApp: () => Promise.resolve(options.status ?? READY),
        githubRepositories: () => Promise.resolve(REPOSITORIES),
        ...options.api,
      }),
    },
  );
  await settle();
  return view;
};

const openDialog = async (view: Awaited<ReturnType<typeof mount>>): Promise<void> => {
  await person().click(view.getByRole('button', { name: 'Create GitHub issue…' }));
  await settle();
};

describe('a thread’s GitHub work', () => {
  test('is not drawn where there is no installation in use, or the person is no member, and has nothing to show', async () => {
    for (const status of [
      { available: false, installation: null, authorization: null } as GitHubAppStatus,
      { available: true, installation: null, authorization: null } as GitHubAppStatus,
      { ...READY, installation: { ...INSTALLATION, suspended: true } } as GitHubAppStatus,
    ]) {
      const view = await mount({ status });
      expect(view.queryByRole('region', { name: 'GitHub' })).toBeNull();
      view.unmount();
    }
    const reader = await mount({ member: false });
    expect(reader.queryByRole('button', { name: 'Create GitHub issue…' })).toBeNull();
    reader.unmount();
  });

  test('lists what the root points at, as links built from their parts, with their state — even with no installation', async () => {
    const view = await mount({
      status: { available: false, installation: null, authorization: null },
      work: [
        LINK,
        { ...LINK, id: '0194a000-0000-7000-8000-000000000002', number: 13, state: 'closed' },
      ],
    });
    const panel = within(view.getByRole('region', { name: 'GitHub' }));
    const link = panel.getByRole('link', { name: 'acme/api#12' });
    expect(link.getAttribute('href')).toBe('https://github.com/acme/api/issues/12');
    expect(link.getAttribute('rel')).toBe('noreferrer');
    expect(panel.getByText('Open')).toBeDefined();
    expect(panel.getByText('Closed')).toBeDefined();
    expect(panel.queryByRole('button', { name: 'Create GitHub issue…' })).toBeNull();
    view.unmount();
  });
});

describe('making an issue', () => {
  test('without the person’s own authorization it asks for it, and leaves for GitHub, coming back to this thread', async () => {
    const returns: string[] = [];
    const went: string[] = [];
    const original = leave.to;
    leave.to = (url): void => {
      went.push(url);
    };
    try {
      const view = await mount({
        status: UNAUTHORISED,
        api: {
          startGitHubAuthorization: (returnTo) => {
            returns.push(returnTo);
            return Promise.resolve({ url: 'https://github.example/authorize?state=s' });
          },
        },
      });
      await openDialog(view);
      const dialog = within(view.getByRole('dialog'));
      expect(dialog.queryByLabelText('Title')).toBeNull();
      await person().click(dialog.getByRole('button', { name: 'Let Purlay create issues as me' }));
      await settle();
      view.unmount();
    } finally {
      leave.to = original;
    }
    expect(returns[0]).toStartWith('/w/acme/c/');
    expect(returns[0]).toContain('?thread=');
    expect(went).toEqual(['https://github.example/authorize?state=s']);
  });

  test('shows the destination and the exact text, marker and all, before Create — and sends exactly that', async () => {
    const sent: CreateGitHubIssueRequest[] = [];
    const view = await mount({
      knowledge: true,
      api: {
        createGitHubIssue: (_id, input) => {
          sent.push(input);
          return Promise.resolve({ status: 'created', link: LINK } satisfies GitHubIssueOutcome);
        },
      },
    });
    await openDialog(view);
    const dialog = within(view.getByRole('dialog'));
    // The destination, who it is as, and the words the answer and decision added.
    const review = within(dialog.getByRole('region', { name: 'What will be created' }));
    expect(review.getByText('In acme/api, as ayse-dev:')).toBeDefined();
    const shown = review.getByText(/Exponential\./).textContent;
    expect(shown).toContain('How should the retry back off?');
    expect(shown).toContain('**Accepted answer**');
    expect(shown).toContain('**Decision**\nUse jitter');
    expect(shown).toContain('[Discussion in Purlay](http');
    expect(shown).toMatch(/<!-- purlay:[0-9a-f-]{36} -->$/);
    await expectNoAxeViolations(view.getByRole('dialog'));
    // Edited, then sent: the review and the request are the same words.
    await person().clear(dialog.getByLabelText('Title'));
    await person().type(dialog.getByLabelText('Title'), 'Yeniden deneme 🙂');
    await person().selectOptions(dialog.getByLabelText('Repository'), '78');
    expect(review.getByText('In acme/web, as ayse-dev:')).toBeDefined();
    await person().click(dialog.getByRole('button', { name: 'Create issue' }));
    await settle();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      repositoryId: 78,
      title: 'Yeniden deneme 🙂',
      copyPrivateText: false,
    });
    expect(`${sent[0]?.body ?? ''}\n\n${githubIssueMarker(sent[0]?.clientRequestId ?? '')}`).toBe(
      review.getByText(/Exponential\./).textContent,
    );
    expect(dialog.getByText('Created acme/api#12.')).toBeDefined();
    expect(dialog.getByRole('link', { name: LINK.url }).getAttribute('href')).toBe(LINK.url);
    // Done: the one thing left is to close it, and nothing can be sent again.
    expect(dialog.queryByRole('button', { name: 'Create issue' })).toBeNull();
    view.unmount();
  });

  test('a conversation that is not public is copied only when the person chooses, and says so in the request', async () => {
    const sent: CreateGitHubIssueRequest[] = [];
    const view = await mount({
      isPublic: false,
      api: {
        createGitHubIssue: (_id, input) => {
          sent.push(input);
          return Promise.resolve({ status: 'created', link: LINK } satisfies GitHubIssueOutcome);
        },
      },
    });
    await openDialog(view);
    const dialog = within(view.getByRole('dialog'));
    const create = dialog.getByRole('button', { name: 'Create issue' });
    expect((create as HTMLButtonElement).disabled).toBe(true);
    await person().click(dialog.getByLabelText(/This conversation is not public/));
    expect((create as HTMLButtonElement).disabled).toBe(false);
    await person().click(create);
    await settle();
    expect(sent[0]?.copyPrivateText).toBe(true);
    view.unmount();
  });

  test('GitHub not answering is said, the words are locked, and Check again is the same request', async () => {
    const ids: string[] = [];
    const answers: GitHubIssueOutcome[] = [
      { status: 'unknown' },
      { status: 'pending' },
      { status: 'created', link: LINK },
    ];
    const view = await mount({
      api: {
        createGitHubIssue: (_id, input) => {
          ids.push(input.clientRequestId);
          return Promise.resolve(answers.shift() ?? { status: 'unknown' });
        },
      },
    });
    await openDialog(view);
    const dialog = within(view.getByRole('dialog'));
    await person().click(dialog.getByRole('button', { name: 'Create issue' }));
    await settle();
    expect(dialog.getByText(/it is not known whether the issue was made/)).toBeDefined();
    expect(dialog.getByLabelText<HTMLInputElement>('Title').disabled).toBe(true);
    await person().click(dialog.getByRole('button', { name: 'Check again' }));
    await settle();
    expect(dialog.getByText(/The issue is being created/)).toBeDefined();
    await person().click(dialog.getByRole('button', { name: 'Check again' }));
    await settle();
    expect(dialog.getByText('Created acme/api#12.')).toBeDefined();
    expect(new Set(ids).size).toBe(1);
    expect(ids).toHaveLength(3);
    view.unmount();
  });

  test('a refusal is said in its own words, and the words changed afterwards are a new request', async () => {
    const ids: string[] = [];
    const answers: GitHubIssueOutcome[] = [
      { status: 'refused', reason: 'no-access' },
      { status: 'refused', reason: 'not-created' },
    ];
    const view = await mount({
      api: {
        createGitHubIssue: (_id, input) => {
          ids.push(input.clientRequestId);
          return Promise.resolve(answers.shift() ?? { status: 'unknown' });
        },
      },
    });
    await openDialog(view);
    const dialog = within(view.getByRole('dialog'));
    await person().click(dialog.getByRole('button', { name: 'Create issue' }));
    await settle();
    expect(
      dialog.getByText('GitHub does not let you create issues in that repository.'),
    ).toBeDefined();
    await person().type(dialog.getByLabelText('Title'), '!');
    expect(dialog.queryByText(/does not let you create issues/)).toBeNull();
    await person().click(dialog.getByRole('button', { name: 'Create issue' }));
    await settle();
    expect(dialog.getByText(/GitHub never showed an issue for this request/)).toBeDefined();
    expect(new Set(ids).size).toBe(2);
    view.unmount();
  });

  test('a failure is said in words and tried again with the same id; a revoked authorization asks for it again', async () => {
    const ids: string[] = [];
    let calls = 0;
    let status = READY;
    const view = await mount({
      api: {
        githubApp: () => Promise.resolve(status),
        createGitHubIssue: (_id, input) => {
          ids.push(input.clientRequestId);
          calls += 1;
          if (calls === 1) return Promise.reject(new ApiError(503, 'GITHUB_UNAVAILABLE', 'no'));
          status = UNAUTHORISED;
          return Promise.reject(new ApiError(409, 'GITHUB_AUTHORIZATION_REQUIRED', 'no'));
        },
      },
    });
    await openDialog(view);
    const dialog = within(view.getByRole('dialog'));
    await person().click(dialog.getByRole('button', { name: 'Create issue' }));
    await settle();
    expect(dialog.getByText(/GitHub did not answer. Nothing was changed/)).toBeDefined();
    await person().click(dialog.getByRole('button', { name: 'Try again' }));
    await settle();
    expect(ids[0]).toBe(ids[1]);
    expect(dialog.getByRole('button', { name: 'Let Purlay create issues as me' })).toBeDefined();
    view.unmount();
  });

  test('no repository to choose, and a failure to list them, are each said — the second with Retry', async () => {
    const none = await mount({
      api: { githubRepositories: () => Promise.resolve({ repositories: [] }) },
    });
    await openDialog(none);
    expect(
      within(none.getByRole('dialog')).getByText(/There is no repository to choose/),
    ).toBeDefined();
    none.unmount();
    let calls = 0;
    const failing = await mount({
      api: {
        githubRepositories: () => {
          calls += 1;
          return calls === 1
            ? Promise.reject(new ApiError(503, 'GITHUB_UNAVAILABLE', 'no'))
            : Promise.resolve(REPOSITORIES);
        },
      },
    });
    await openDialog(failing);
    const dialog = within(failing.getByRole('dialog'));
    expect(dialog.getByText(/The repositories could not be read/)).toBeDefined();
    await person().click(dialog.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(dialog.getByLabelText('Repository')).toBeDefined();
    failing.unmount();
  });

  test('cancel closes it without sending anything', async () => {
    const view = await mount({});
    await openDialog(view);
    await person().click(within(view.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(view.queryByRole('dialog')).toBeNull();
    view.unmount();
  });
});

describe('pointing a thread at work that exists', () => {
  const openLink = async (view: Awaited<ReturnType<typeof mount>>): Promise<void> => {
    await person().click(view.getByRole('button', { name: 'Link an issue or pull request…' }));
    await settle();
  };

  test('takes an address as the contract holds every GitHub link, and sends it as written', async () => {
    const sent: string[] = [];
    const view = await mount({
      api: {
        linkGitHubWork: (_id, input) => {
          sent.push(input.url);
          return Promise.resolve({ ...LINK, state: 'merged', kind: 'pull' });
        },
      },
    });
    await openLink(view);
    const dialog = within(view.getByRole('dialog'));
    const link = dialog.getByRole('button', { name: 'Link' });
    expect((link as HTMLButtonElement).disabled).toBe(true);
    await person().type(
      dialog.getByLabelText('Address on GitHub'),
      'https://gitlab.com/a/b/issues/1',
    );
    expect(dialog.getByText(/not the address of an issue or a pull request/)).toBeDefined();
    expect((link as HTMLButtonElement).disabled).toBe(true);
    await person().clear(dialog.getByLabelText('Address on GitHub'));
    await person().type(
      dialog.getByLabelText('Address on GitHub'),
      '  https://github.com/acme/api/pull/12  ',
    );
    await expectNoAxeViolations(view.getByRole('dialog'));
    await person().click(link);
    await settle();
    expect(sent).toEqual(['https://github.com/acme/api/pull/12']);
    expect(view.queryByRole('dialog')).toBeNull();
    view.unmount();
  });

  test('says in words that it does not exist or cannot be reached, and that a thread can hold no more', async () => {
    const answers = [
      new ApiError(400, 'VALIDATION_FAILED', 'GitHub has no such issue or pull request.'),
      new ApiError(400, 'VALIDATION_FAILED', 'This thread already points at as much as it can.'),
    ];
    const view = await mount({
      api: {
        linkGitHubWork: () =>
          Promise.reject(answers.shift() ?? new ApiError(500, 'INTERNAL', 'Something went wrong.')),
      },
    });
    await openLink(view);
    const dialog = within(view.getByRole('dialog'));
    await person().type(
      dialog.getByLabelText('Address on GitHub'),
      'https://github.com/acme/api/issues/1',
    );
    await person().click(dialog.getByRole('button', { name: 'Link' }));
    await settle();
    expect(
      dialog.getByText(
        /GitHub has no such issue or pull request that you and the App can both reach/,
      ),
    ).toBeDefined();
    await person().click(dialog.getByRole('button', { name: 'Link' }));
    await settle();
    expect(dialog.getByText(/already points at as much GitHub work as it can/)).toBeDefined();
    view.unmount();
  });

  test('without the person’s own authorization it asks for it first, coming back to this thread', async () => {
    const returns: string[] = [];
    const original = leave.to;
    leave.to = (): void => undefined;
    try {
      const view = await mount({
        status: UNAUTHORISED,
        api: {
          startGitHubAuthorization: (returnTo) => {
            returns.push(returnTo);
            return Promise.resolve({ url: 'https://github.example/authorize?state=s' });
          },
        },
      });
      await openLink(view);
      const dialog = within(view.getByRole('dialog'));
      expect(dialog.queryByLabelText('Address on GitHub')).toBeNull();
      await person().click(dialog.getByRole('button', { name: 'Let Purlay create issues as me' }));
      await settle();
      view.unmount();
    } finally {
      leave.to = original;
    }
    expect(returns[0]).toContain('?thread=');
  });

  test('shows a merged pull request as merged', async () => {
    const view = await mount({
      work: [
        { ...LINK, kind: 'pull', state: 'merged', url: 'https://github.com/acme/api/pull/12' },
      ],
    });
    expect(within(view.getByRole('region', { name: 'GitHub' })).getByText('Merged')).toBeDefined();
    view.unmount();
  });
});

describe('the link dialog on a bad day', () => {
  test('a refusal that is not the address is said as it is, Enter sends, and Cancel closes', async () => {
    const view = await mount({
      api: {
        linkGitHubWork: () => Promise.reject(new ApiError(503, 'GITHUB_UNAVAILABLE', 'no')),
      },
    });
    await person().click(view.getByRole('button', { name: 'Link an issue or pull request…' }));
    await settle();
    const dialog = within(view.getByRole('dialog'));
    await person().type(
      dialog.getByLabelText('Address on GitHub'),
      'https://github.com/acme/api/issues/1{Enter}',
    );
    await settle();
    expect(dialog.getByText(/GitHub did not answer. Nothing was changed/)).toBeDefined();
    await person().click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(view.queryByRole('dialog')).toBeNull();
    view.unmount();
  });

  test('an authorization GitHub no longer takes is asked for again', async () => {
    let status = READY;
    const view = await mount({
      api: {
        githubApp: () => Promise.resolve(status),
        linkGitHubWork: () => {
          status = UNAUTHORISED;
          return Promise.reject(new ApiError(409, 'GITHUB_AUTHORIZATION_REQUIRED', 'no'));
        },
      },
    });
    await person().click(view.getByRole('button', { name: 'Link an issue or pull request…' }));
    await settle();
    const dialog = within(view.getByRole('dialog'));
    await person().type(
      dialog.getByLabelText('Address on GitHub'),
      'https://github.com/acme/api/issues/1',
    );
    await person().click(dialog.getByRole('button', { name: 'Link' }));
    await settle();
    expect(dialog.getByRole('button', { name: 'Let Purlay create issues as me' })).toBeDefined();
    view.unmount();
  });

  test('an authorization that cannot be started is said', async () => {
    const view = await mount({
      status: UNAUTHORISED,
      api: {
        startGitHubAuthorization: () => Promise.reject(new ApiError(500, 'INTERNAL', 'no')),
      },
    });
    await person().click(view.getByRole('button', { name: 'Link an issue or pull request…' }));
    await settle();
    const dialog = within(view.getByRole('dialog'));
    await person().click(dialog.getByRole('button', { name: 'Let Purlay create issues as me' }));
    await settle();
    expect(dialog.getByText(/Something went wrong/)).toBeDefined();
    view.unmount();
  });
});
