/**
 * The __TITLE__ screen as a person meets it (`docs/MODULES.md` §11): the list in each state it can be in, making a row, a
 * refusal, a second submit, and the module's absence — no rail link, no screen and no request — on a server that does not run it.
 */
import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { act, within } from '@testing-library/react';
import type { __PASCAL__Item, MeResponse, ModuleId } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import { workspaceAccessChanged } from '../../data/access-change';
import type { Api } from '../../data/api';
import { ApiError } from '../../data/errors';
import { keys } from '../../data/keys';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { aSession, aSignedInApi } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { Toaster } from '../../ui/toast';

installDom();

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const aRow = (n: number, title = `Row ${String(n)}`): __PASCAL__Item => ({
  id: `0199155c-${(0x8000 + n).toString(16).padStart(4, '0')}-7b7f-8c11-2a4d3f9e1b70`,
  title,
  createdAt: '2026-09-09T11:00:00.000Z',
});

/** A session on a server that runs these modules. */
const session = (modules: readonly ModuleId[]): MeResponse => ({ ...aSession(), modules: [...modules] });

const visit = async (
  api: Partial<Api>,
  modules: readonly ModuleId[] = ['chat', '__ID__'],
): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  const view = await renderApp(
    <>
      <Outlet />
      <Toaster dismissLabel="Close" />
    </>,
    {
      path: '/w/acme/__ID__',
      api: aSignedInApi({ me: () => Promise.resolve(session(modules)), ...api }),
    },
  );
  await settle();
  return view;
};

describe('the __TITLE__ screen', () => {
  test('says it is loading while the list is on its way, and asks for it once', async () => {
    let asked = 0;
    const view = await visit({
      list__PASCAL__: () => {
        asked += 1;
        return new Promise(() => undefined);
      },
    });
    expect(view.getByRole('heading', { level: 1, name: '__TITLE__' })).toBeDefined();
    expect(within(view.getByRole('main')).getByRole('status').textContent).toBe('Loading __LOWER__');
    expect(asked).toBe(1);
    view.unmount();
  });

  test('lists the rows as the server gave them, and has nothing for axe to object to', async () => {
    const view = await visit({
      list__PASCAL__: () => Promise.resolve([aRow(2), aRow(1)]),
    });
    const rows = within(view.getByRole('main')).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual(['Row 2', 'Row 1']);
    await expectNoAxeViolations(view.container);
    view.unmount();
  });

  test('an empty list invites the first row', async () => {
    const view = await visit({ list__PASCAL__: () => Promise.resolve([]) });
    expect(view.getByText('Nothing here yet')).toBeDefined();
    expect(within(view.getByRole('main')).queryAllByRole('listitem')).toHaveLength(0);
    view.unmount();
  });

  test('a list the server will not give says so and can be asked again', async () => {
    let tries = 0;
    const view = await visit({
      list__PASCAL__: () => {
        tries += 1;
        return tries === 1
          ? Promise.reject(new ApiError(503, 'DATABASE_UNAVAILABLE', 'down'))
          : Promise.resolve([aRow(1)]);
      },
    });
    expect(view.getByText('__TITLE__ could not be loaded')).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(view.getByText('Row 1')).toBeDefined();
    view.unmount();
  });

  test('makes a row from a title, empties the field and reads the list again', async () => {
    const made: unknown[] = [];
    let reads = 0;
    const view = await visit({
      list__PASCAL__: () => {
        reads += 1;
        return Promise.resolve(made.length === 0 ? [] : [aRow(1, 'Fix it')]);
      },
      create__PASCAL__Item: (_workspace, input) => {
        made.push(input);
        return Promise.resolve(aRow(1, 'Fix it'));
      },
    });
    const add = view.getByRole('button', { name: 'Add' });
    expect(add.hasAttribute('disabled')).toBe(true);
    // Spaces are no title.
    await person().type(view.getByRole('textbox', { name: 'New item' }), '   ');
    expect(add.hasAttribute('disabled')).toBe(true);
    await person().clear(view.getByRole('textbox', { name: 'New item' }));
    await person().type(view.getByRole('textbox', { name: 'New item' }), '  Fix it ');
    await person().click(add);
    await settle();
    expect(made).toEqual([{ title: 'Fix it' }]);
    expect((view.getByRole('textbox', { name: 'New item' }) as HTMLInputElement).value).toBe('');
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(view.getByText('Fix it')).toBeDefined();
    view.unmount();
  });

  test('a second submit while the first is on its way is not a second row', async () => {
    let made = 0;
    let finish: () => void = () => undefined;
    const view = await visit({
      list__PASCAL__: () => Promise.resolve([]),
      create__PASCAL__Item: () => {
        made += 1;
        return new Promise((resolve) => {
          finish = (): void => {
            resolve(aRow(1));
          };
        });
      },
    });
    await person().type(view.getByRole('textbox', { name: 'New item' }), 'Once{Enter}{Enter}');
    await settle();
    expect(made).toBe(1);
    finish();
    await settle();
    view.unmount();
  });

  test('a refused row keeps the title and says why', async () => {
    const view = await visit({
      list__PASCAL__: () => Promise.resolve([]),
      create__PASCAL__Item: () => Promise.reject(new ApiError(400, 'VALIDATION_FAILED', 'no')),
    });
    await person().type(view.getByRole('textbox', { name: 'New item' }), 'Fix it');
    await person().click(view.getByRole('button', { name: 'Add' }));
    await settle();
    expect(view.getByText(/It was not added\./)).toBeDefined();
    expect((view.getByRole('textbox', { name: 'New item' }) as HTMLInputElement).value).toBe('Fix it');
    view.unmount();
  });
});

describe('what the client keeps of the rows', () => {
  test('forgets a workspace’s rows when the person’s access to it changes, and no other workspace’s', () => {
    const client = new QueryClient();
    client.setQueryData(keys.__CAMEL__('workspace-1'), [aRow(1)]);
    client.setQueryData(keys.__CAMEL__('workspace-2'), [aRow(2)]);
    workspaceAccessChanged(client, 'workspace-1');
    expect(client.getQueryData(keys.__CAMEL__('workspace-1'))).toBeUndefined();
    expect(client.getQueryData(keys.__CAMEL__('workspace-2'))).toEqual([aRow(2)]);
  });
});

describe('where the server does not run the module', () => {
  test('the address is not found and nothing of __ID__ is asked for, drawn or offered', async () => {
    let asked = 0;
    const view = await visit(
      {
        list__PASCAL__: () => {
          asked += 1;
          return Promise.resolve([]);
        },
      },
      ['chat'],
    );
    expect(asked).toBe(0);
    expect(view.queryByRole('heading', { level: 1, name: '__TITLE__' })).toBeNull();
    expect(view.queryByRole('link', { name: '__TITLE__' })).toBeNull();
    view.unmount();
  });

  test('the rail offers it where it runs, beside chat or alone', async () => {
    for (const modules of [['chat', '__ID__'], ['__ID__']] as const) {
      const view = await visit({ list__PASCAL__: () => Promise.resolve([]) }, modules);
      expect(view.getByRole('link', { name: '__TITLE__' })).toBeDefined();
      view.unmount();
    }
  });
});
