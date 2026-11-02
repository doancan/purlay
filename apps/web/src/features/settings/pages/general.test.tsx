/**
 * General (D-124, D-146), through the real frame at the page's address: an owner's or an admin's, the
 * name changed everywhere in the tab at once, the address said, copied and kept, and a refusal that
 * keeps what was typed.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { BoundFunctions, queries } from '@testing-library/react';
import type { UserRole } from '@purlay/types';
import { Outlet } from '../../../app/outlet';
import type { Api } from '../../../data/api';
import { ApiError } from '../../../data/errors';
import { expectNoAxeViolations } from '../../../testing/axe';
import { installDom } from '../../../testing/dom';
import { WORKSPACE, aSession, aSignedInApi } from '../../../testing/fixtures';
import { renderApp } from '../../../testing/render';
import { person } from '../../../testing/user';
import { Toaster } from '../../../ui/toast';
import { ContentPortsContext, type ContentPorts } from '../../content/content-ports';

installDom();

/** What `within` answers: the queries, bound to one part of the page. */
type Scope = BoundFunctions<typeof queries>;

type View = Awaited<ReturnType<typeof renderApp>>;

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const render = async (
  path: string,
  api: Partial<Api>,
  role: UserRole = 'owner',
  ports?: ContentPorts,
): Promise<View> => {
  const session = aSession();
  const view = await renderApp(
    <>
      {ports === undefined ? (
        <Outlet />
      ) : (
        <ContentPortsContext.Provider value={ports}>
          <Outlet />
        </ContentPortsContext.Provider>
      )}
      <Toaster dismissLabel="Dismiss" />
    </>,
    {
      path,
      api: aSignedInApi({
        me: () =>
          Promise.resolve({
            ...session,
            memberships: session.memberships.map((m) => ({ ...m, role })),
          }),
        ...api,
      }),
    },
  );
  await settle();
  return view;
};

const openPage = async (
  api: Partial<Api>,
  role: UserRole = 'owner',
  ports?: ContentPorts,
): Promise<View> => {
  const view = await render('/w/acme/settings/general', api, role, ports);
  await view.findByRole('heading', { level: 1, name: 'General' });
  return view;
};

const main = (view: View): Scope => within(view.getByRole('main'));
const field = (view: View): HTMLInputElement => main(view).getByLabelText<HTMLInputElement>('Name');

describe('general', () => {
  test('is an owner’s and an admin’s; a member is not offered it, and its address is not found', async () => {
    const member = await render('/w/acme/settings/general', {}, 'member');
    expect(await member.findByText('Nothing here')).toBeDefined();
    expect(member.queryByRole('link', { name: 'General' })).toBeNull();
    member.unmount();
    const admin = await openPage({}, 'admin');
    expect(admin.getByRole('link', { name: 'General' }).getAttribute('aria-current')).toBe('page');
    admin.unmount();
  });

  test('a new name is saved, and shows in the sidebar at once; the address is said and kept', async () => {
    const asked: [string, string][] = [];
    const view = await openPage({
      renameWorkspace: (workspaceId, name) => {
        asked.push([workspaceId, name]);
        return Promise.resolve({ ...WORKSPACE, name });
      },
    });
    const page = view.getByRole('main');
    expect(page.textContent).toContain(`/w/${WORKSPACE.slug}`);
    await expectNoAxeViolations(page);
    const save = main(view).getByRole('button', { name: 'Save' });
    // Nothing changed, nothing to save.
    expect(save).toHaveProperty('disabled', true);
    expect(field(view).value).toBe(WORKSPACE.name);
    await person().clear(field(view));
    await person().type(field(view), '  Acme Platform ');
    await person().click(save);
    await settle();
    expect(asked).toEqual([[WORKSPACE.id, 'Acme Platform']]);
    expect(main(view).getByRole('status').textContent).toBe('Saved.');
    expect(field(view).value).toBe('Acme Platform');
    expect(
      within(view.getByRole('complementary')).getByText('Back to Acme Platform'),
    ).toBeDefined();
    view.unmount();
  });

  test('the whole address is shown and copied in one press', async () => {
    const copied: string[] = [];
    const view = await openPage({}, 'owner', {
      highlight: () => Promise.resolve(null),
      copy: (text) => {
        copied.push(text);
        return Promise.resolve();
      },
    });
    const address = `${window.location.origin}/w/${WORKSPACE.slug}`;
    const shown = main(view).getByText(address);
    // Too long for the box, it is cut with an ellipsis and said whole on hover.
    expect(shown.className.split(' ')).toContain('truncate');
    expect(shown.closest('code')?.getAttribute('title')).toBe(address);
    await person().click(main(view).getByRole('button', { name: 'Copy' }));
    await settle();
    expect(copied).toEqual([address]);
    expect(view.getByText('Copied')).toBeDefined();
    view.unmount();
  });

  test('a clipboard that refuses is said', async () => {
    const view = await openPage({}, 'owner', {
      highlight: () => Promise.resolve(null),
      copy: () => Promise.reject(new Error('the clipboard is not allowed here')),
    });
    await person().click(main(view).getByRole('button', { name: 'Copy' }));
    await settle();
    expect(view.getByText(/Couldn't copy/)).toBeDefined();
    view.unmount();
  });

  test('left without saving, nothing is asked; come back to, it starts from the name as it is', async () => {
    let calls = 0;
    const view = await openPage({
      renameWorkspace: () => {
        calls += 1;
        return Promise.resolve(WORKSPACE);
      },
    });
    await person().type(field(view), ' half typed');
    await person().click(view.getByRole('link', { name: 'Profile' }));
    await view.findByRole('heading', { level: 1, name: 'Profile' });
    expect(calls).toBe(0);
    await person().click(view.getByRole('link', { name: 'General' }));
    await view.findByRole('heading', { level: 1, name: 'General' });
    expect(field(view).value).toBe(WORKSPACE.name);
    view.unmount();
  });

  test('a blank name is not sent; a refusal says why and keeps what was typed', async () => {
    let calls = 0;
    const view = await openPage({
      renameWorkspace: () => {
        calls += 1;
        return Promise.reject(new ApiError(500, 'INTERNAL', 'no'));
      },
    });
    const page = view.getByRole('main');
    await person().clear(field(view));
    await person().type(field(view), '   ');
    await person().click(main(view).getByRole('button', { name: 'Save' }));
    expect(page.textContent).toContain('A workspace needs a name.');
    expect(calls).toBe(0);
    await person().clear(field(view));
    await person().type(field(view), 'Kept');
    await person().click(main(view).getByRole('button', { name: 'Save' }));
    await settle();
    expect(calls).toBe(1);
    expect(page.textContent).toContain('The name was not changed.');
    expect(field(view).value).toBe('Kept');
    view.unmount();
  });

  test('another workspace is offered only to whom the server lets make one (D-155)', async () => {
    const session = aSession();
    const view = await openPage({
      me: () =>
        Promise.resolve({
          ...session,
          memberships: session.memberships.map((m) => ({ ...m, role: 'owner' as const })),
          mayCreateWorkspace: false,
        }),
    });
    // An owner the server would refuse sees no form to be refused by.
    expect(main(view).queryByRole('button', { name: 'Create workspace…' })).toBeNull();
    expect(main(view).queryByText('Another workspace')).toBeNull();
    view.unmount();
  });

  test('Create workspace… opens the form for another', async () => {
    const view = await openPage({});
    await person().click(main(view).getByRole('button', { name: 'Create workspace…' }));
    const dialog = view.getByRole('dialog', { name: 'Create a workspace' });
    // Its footer is every dialog's: Cancel, then the action, at the right; Cancel closes it.
    const buttons = within(dialog)
      .getAllByRole('button')
      .map((button) => button.textContent)
      .filter((words) => words !== '');
    expect(buttons.slice(-2)).toEqual(['Cancel', 'Create workspace']);
    await person().click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(view.queryByRole('dialog', { name: 'Create a workspace' })).toBeNull();
    view.unmount();
  });

  test('a workspace made there closes the form and goes to it, with Back to these settings', async () => {
    const asked: { name: string; slug: string }[] = [];
    const view = await openPage({
      createWorkspace: (input) => {
        asked.push(input);
        return Promise.resolve({
          id: WORKSPACE.id,
          name: input.name,
          slug: input.slug,
          avatarUrl: null,
        });
      },
    });
    const before = view.world.history.stack.length;
    await person().click(main(view).getByRole('button', { name: 'Create workspace…' }));
    const dialog = view.getByRole('dialog', { name: 'Create a workspace' });
    await person().type(within(dialog).getByLabelText('Name'), 'New team');
    await person().click(within(dialog).getByRole('button', { name: 'Create workspace' }));
    await settle();
    expect(asked).toEqual([{ name: 'New team', slug: 'new-team' }]);
    expect(view.queryByRole('dialog', { name: 'Create a workspace' })).toBeNull();
    expect(view.world.history.stack.at(-1)).toMatch(/^\/w\/new-team/);
    expect(view.world.history.stack.length).toBeGreaterThan(before);
    view.unmount();
  });
});

describe('archived channels (D-232)', () => {
  const OLD = {
    id: '00000000-0000-4000-8000-0000000000a1',
    name: 'old-launch',
    type: 'public' as const,
    archivedAt: '2026-10-30T08:00:00.000Z',
  };
  const SECRET = {
    id: '00000000-0000-4000-8000-0000000000a2',
    name: 'secret',
    type: 'private' as const,
    archivedAt: '2026-10-29T08:00:00.000Z',
  };
  const card = (view: View): Scope =>
    within(main(view).getByRole('region', { name: 'Archived channels' }));

  test('each is listed with when it was archived, a private one said so, and the card passes axe', async () => {
    const view = await openPage({ archivedChannels: () => Promise.resolve([OLD, SECRET]) });
    const rows = card(view)
      .getAllByRole('listitem')
      .map((row) => row.textContent);
    expect(rows[0]).toMatch(/^#old-launch, archived .*Restore$/);
    expect(rows[1]).toMatch(/^#secret \(private\), archived .*Restore$/);
    await expectNoAxeViolations(view.getByRole('main'));
    view.unmount();
  });

  test('restored, it leaves the list and is said; the list and the channels are read again', async () => {
    let archived = [OLD];
    const restored: string[] = [];
    const view = await openPage({
      archivedChannels: () => Promise.resolve(archived),
      restoreChannel: (channelId) => {
        restored.push(channelId);
        archived = [];
        return Promise.resolve();
      },
    });
    await person().click(card(view).getByRole('button', { name: 'Restore' }));
    await settle();
    expect(restored).toEqual([OLD.id]);
    expect(view.getByText('#old-launch is back.')).toBeDefined();
    expect(card(view).getByText('No channel is archived.')).toBeDefined();
    view.unmount();
  });

  test('a name taken since is said with what to do, and the channel stays listed', async () => {
    const view = await openPage({
      archivedChannels: () => Promise.resolve([OLD]),
      restoreChannel: () =>
        Promise.reject(new ApiError(409, 'CHANNEL_NAME_TAKEN', 'A channel with that name exists.')),
    });
    await person().click(card(view).getByRole('button', { name: 'Restore' }));
    await settle();
    expect(
      view.getByText(
        'Another channel is called #old-launch now. Rename that one, then restore this.',
      ),
    ).toBeDefined();
    expect(card(view).getAllByRole('listitem')).toHaveLength(1);
    view.unmount();
  });

  test('none is said plainly; a list that fails to load offers a retry that reads it again', async () => {
    const empty = await openPage({ archivedChannels: () => Promise.resolve([]) });
    expect(card(empty).getByText('No channel is archived.')).toBeDefined();
    empty.unmount();

    let asks = 0;
    const failing = await openPage({
      archivedChannels: () => {
        asks += 1;
        return asks === 1
          ? Promise.reject(new ApiError(500, 'INTERNAL', 'no'))
          : Promise.resolve([OLD]);
      },
    });
    expect(card(failing).getByText('Archived channels could not be loaded.')).toBeDefined();
    await person().click(card(failing).getByRole('button', { name: 'Retry' }));
    await settle();
    expect(card(failing).getAllByRole('listitem')).toHaveLength(1);
    failing.unmount();
  });
});
