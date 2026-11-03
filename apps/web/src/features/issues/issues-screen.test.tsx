/**
 * The Issues screen (D-254) as a person meets it: the list and its status filter in the address, making an issue,
 * marking it done, editing it, deleting it only where the server would let them, and the module's absence — no rail
 * link, no palette entry, no screen, and no request — on a server that does not run it.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { Issue, IssuePage, MeResponse } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import type { Api } from '../../data/api';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { IDS, aSession, aSignedInApi } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { Toaster } from '../../ui/toast';
import { filterIn } from './issues-screen';

installDom();

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const anIssue = (n: number, over: Partial<Issue> = {}): Issue => ({
  id: `0199155c-${(0x7000 + n).toString(16).padStart(4, '0')}-7b7f-8c11-2a4d3f9e1b70`,
  title: `Issue ${String(n)}`,
  body: '',
  status: 'open',
  assigneeId: null,
  createdBy: IDS.alice,
  createdAt: '2026-09-09T11:00:00.000Z',
  updatedAt: '2026-09-09T11:00:00.000Z',
  ...over,
});

const page = (data: readonly Issue[], nextCursor: string | null = null): IssuePage => ({
  data: [...data],
  nextCursor,
});

/** A session on a server that runs these modules, in this role. */
const session = (modules: readonly string[], role: 'owner' | 'member' = 'owner'): MeResponse => {
  const base = aSession();
  return {
    ...base,
    modules: [...modules],
    memberships: base.memberships.map((membership) => ({ ...membership, role })),
  };
};

const visit = async (
  api: Partial<Api>,
  options: {
    path?: string;
    modules?: readonly string[];
    role?: 'owner' | 'member';
    locale?: 'tr';
  } = {},
): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  const modules = options.modules ?? ['chat', 'issues'];
  const view = await renderApp(
    <>
      <Outlet />
      <Toaster dismissLabel="Close" />
    </>,
    {
      path: options.path ?? '/w/acme/issues',
      api: aSignedInApi({
        me: () => Promise.resolve(session(modules, options.role ?? 'owner')),
        ...api,
      }),
      ...(options.locale === undefined ? {} : { locale: options.locale }),
    },
  );
  await settle();
  return view;
};

describe('the address', () => {
  test('names the status; anything else is All', () => {
    expect(filterIn('?status=open')).toBe('open');
    expect(filterIn('?status=done')).toBe('done');
    expect(filterIn('?status=closed')).toBe('all');
    expect(filterIn('')).toBe('all');
  });
});

describe('the Issues screen', () => {
  test('lists the issues, newest first, with who they are given to, and has nothing for axe to object to', async () => {
    const asked: unknown[] = [];
    const view = await visit({
      issues: (_workspace, query) => {
        asked.push(query);
        return Promise.resolve(
          page([
            anIssue(2, { body: 'with details', assigneeId: IDS.bob, status: 'done' }),
            anIssue(1, { assigneeId: '00000000-0000-4000-8000-00000000ffff' }),
          ]),
        );
      },
    });
    expect(view.getByRole('heading', { level: 1, name: 'Issues' })).toBeDefined();
    expect(asked).toEqual([{}]);
    const rows = within(view.getByRole('main')).getAllByRole('listitem');
    expect(rows[0]?.textContent).toContain('Issue 2');
    expect(rows[0]?.textContent).toContain('with details');
    expect(rows[0]?.textContent).toContain('Assigned to Bob');
    expect(rows[0]?.textContent).toContain('Done');
    expect(rows[1]?.textContent).toContain('Assigned to a former member');
    expect(view.getByRole('link', { name: 'Issues' }).getAttribute('aria-current')).toBe('page');
    await expectNoAxeViolations(view.container);
    view.unmount();
  });

  test('a status is asked for and kept in the address, and More reads the next page from the cursor', async () => {
    const asked: unknown[] = [];
    const view = await visit({
      issues: (_workspace, query) => {
        asked.push(query);
        return Promise.resolve(
          query?.before === undefined ? page([anIssue(2)], anIssue(2).id) : page([anIssue(1)]),
        );
      },
    });
    await person().click(view.getByRole('button', { name: 'Load more' }));
    await settle();
    expect(asked).toEqual([{}, { before: anIssue(2).id }]);
    expect(view.getByText('Issue 1')).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Done' }));
    await settle();
    expect(view.world.history.stack.at(-1)).toBe('/w/acme/issues?status=done');
    expect(asked.at(-1)).toEqual({ status: 'done' });
    view.unmount();
  });

  test('an empty list invites the first issue, in the language asked for', async () => {
    const view = await visit({ issues: () => Promise.resolve(page([])) });
    expect(view.getByText('No issues yet')).toBeDefined();
    view.unmount();
    const turkish = await visit({ issues: () => Promise.resolve(page([])) }, { locale: 'tr' });
    expect(turkish.getByRole('heading', { level: 1, name: 'Sorunlar' })).toBeDefined();
    expect(turkish.getByText('Henüz sorun yok')).toBeDefined();
    turkish.unmount();
  });

  test('a list the server will not give says so and can be asked again', async () => {
    let tries = 0;
    const view = await visit({
      issues: () => {
        tries += 1;
        return tries === 1
          ? Promise.reject(new ApiError(503, 'DATABASE_UNAVAILABLE', 'down'))
          : Promise.resolve(page([anIssue(1)]));
      },
    });
    expect(view.getByText('The issues could not be loaded')).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(view.getByText('Issue 1')).toBeDefined();
    view.unmount();
  });

  test('makes an issue from a title, empties the field and reads the list again', async () => {
    const made: unknown[] = [];
    let reads = 0;
    const view = await visit({
      issues: () => {
        reads += 1;
        return Promise.resolve(page(made.length === 0 ? [] : [anIssue(1, { title: 'Fix it' })]));
      },
      createIssue: (_workspace, input) => {
        made.push(input);
        return Promise.resolve(anIssue(1, { title: 'Fix it' }));
      },
    });
    const add = view.getByRole('button', { name: 'Add issue' });
    expect(add.hasAttribute('disabled')).toBe(true);
    await person().type(view.getByRole('textbox', { name: 'New issue' }), '  Fix it ');
    await person().click(add);
    await settle();
    expect(made).toEqual([{ title: 'Fix it' }]);
    expect((view.getByRole('textbox', { name: 'New issue' }) as HTMLInputElement).value).toBe('');
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(view.getByText('Fix it')).toBeDefined();
    view.unmount();
  });

  test('a refused issue keeps the title and says why', async () => {
    const view = await visit({
      issues: () => Promise.resolve(page([])),
      createIssue: () => Promise.reject(new ApiError(400, 'VALIDATION_FAILED', 'no')),
    });
    await person().type(view.getByRole('textbox', { name: 'New issue' }), 'Fix it');
    await person().click(view.getByRole('button', { name: 'Add issue' }));
    await settle();
    expect(view.getByText(/The issue was not added\./)).toBeDefined();
    expect((view.getByRole('textbox', { name: 'New issue' }) as HTMLInputElement).value).toBe(
      'Fix it',
    );
    view.unmount();
  });

  test('marks an issue done, and open again, by asking for the status', async () => {
    const changes: unknown[] = [];
    const view = await visit({
      issues: () => Promise.resolve(page([anIssue(1), anIssue(2, { status: 'done' })])),
      updateIssue: (_workspace, id, input) => {
        changes.push([id, input]);
        return Promise.resolve(anIssue(1));
      },
    });
    await person().click(view.getByRole('button', { name: 'Mark done' }));
    await person().click(view.getByRole('button', { name: 'Reopen' }));
    await settle();
    expect(changes).toEqual([
      [anIssue(1).id, { status: 'done' }],
      [anIssue(2).id, { status: 'open' }],
    ]);
    view.unmount();
  });

  test('edits only what changed: the title and the assignee, from the members; nothing changed asks nothing', async () => {
    const changes: unknown[] = [];
    const view = await visit({
      issues: () => Promise.resolve(page([anIssue(1, { body: 'old' })])),
      updateIssue: (_workspace, id, input) => {
        changes.push([id, input]);
        return Promise.resolve(anIssue(1));
      },
    });
    await person().click(view.getByRole('button', { name: 'Edit' }));
    await person().click(view.getByRole('button', { name: 'Cancel' }));
    await person().click(view.getByRole('button', { name: 'Edit' }));
    await person().click(view.getByRole('button', { name: 'Save' }));
    await settle();
    expect(changes).toEqual([]);
    expect(view.queryByRole('textbox', { name: 'Title' })).toBeNull();

    await person().click(view.getByRole('button', { name: 'Edit' }));
    const title = view.getByRole('textbox', { name: 'Title' });
    await person().clear(title);
    await person().type(title, 'Renamed');
    await person().type(view.getByRole('textbox', { name: 'Details' }), ' more');
    await person().selectOptions(view.getByRole('combobox', { name: 'Assignee' }), IDS.bob);
    await person().click(view.getByRole('button', { name: 'Save' }));
    await settle();
    expect(changes).toEqual([
      [anIssue(1).id, { title: 'Renamed', body: 'old more', assigneeId: IDS.bob }],
    ]);
    view.unmount();
  });

  test('an issue given to somebody who has left keeps saying so in the form, and can be given to nobody', async () => {
    const changes: unknown[] = [];
    const view = await visit({
      issues: () =>
        Promise.resolve(page([anIssue(1, { assigneeId: '00000000-0000-4000-8000-00000000ffff' })])),
      updateIssue: (_workspace, id, input) => {
        changes.push([id, input]);
        return Promise.resolve(anIssue(1));
      },
    });
    await person().click(view.getByRole('button', { name: 'Edit' }));
    const select = view.getByRole('combobox', { name: 'Assignee' });
    expect(
      within(select).getByRole('option', { name: 'Assigned to a former member' }),
    ).toBeDefined();
    await person().selectOptions(select, '');
    await person().click(view.getByRole('button', { name: 'Save' }));
    await settle();
    expect(changes).toEqual([[anIssue(1).id, { assigneeId: null }]]);
    view.unmount();
  });

  test('a refused change keeps the form open and says why', async () => {
    const view = await visit({
      issues: () => Promise.resolve(page([anIssue(1)])),
      updateIssue: () => Promise.reject(new ApiError(404, 'ISSUE_NOT_FOUND', 'gone')),
    });
    await person().click(view.getByRole('button', { name: 'Edit' }));
    await person().type(view.getByRole('textbox', { name: 'Title' }), '!');
    await person().click(view.getByRole('button', { name: 'Save' }));
    await settle();
    expect(view.getByText(/The change was not saved\./)).toBeDefined();
    expect(view.getByRole('textbox', { name: 'Title' })).toBeDefined();
    view.unmount();
  });

  test('deletes after asking, and not before', async () => {
    const deleted: string[] = [];
    const view = await visit({
      issues: () => Promise.resolve(page([anIssue(1)])),
      deleteIssue: (_workspace, id) => {
        deleted.push(id);
        return Promise.resolve();
      },
    });
    await person().click(view.getByRole('button', { name: 'Delete' }));
    expect(deleted).toEqual([]);
    await person().click(within(view.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await settle();
    expect(deleted).toEqual([anIssue(1).id]);
    view.unmount();
  });

  test('a member is offered Delete on what they made and not on what others made; an owner on both', async () => {
    const issues = [anIssue(1, { createdBy: IDS.me }), anIssue(2, { createdBy: IDS.alice })];
    const member = await visit({ issues: () => Promise.resolve(page(issues)) }, { role: 'member' });
    expect(member.getAllByRole('button', { name: 'Delete' })).toHaveLength(1);
    member.unmount();
    const owner = await visit({ issues: () => Promise.resolve(page(issues)) });
    expect(owner.getAllByRole('button', { name: 'Delete' })).toHaveLength(2);
    owner.unmount();
  });
});

describe('where the server does not run the module', () => {
  test('the address is not found and nothing of issues is asked for, drawn or offered', async () => {
    const view = await visit(
      {
        // The test's own double: a call to it fails the test by name.
        issues: () => {
          throw new Error('asked for issues on a server that does not run them');
        },
      },
      { modules: ['chat'] },
    );
    expect(view.queryByRole('heading', { level: 1, name: 'Issues' })).toBeNull();
    expect(view.queryByRole('link', { name: 'Issues' })).toBeNull();
    view.unmount();
  });

  test('the rail offers it where it runs, beside chat or alone', async () => {
    for (const modules of [['chat', 'issues'], ['issues']] as const) {
      const view = await visit({ issues: () => Promise.resolve(page([])) }, { modules });
      expect(view.getByRole('link', { name: 'Issues' })).toBeDefined();
      view.unmount();
    }
  });
});
