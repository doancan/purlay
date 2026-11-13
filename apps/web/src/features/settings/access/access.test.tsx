/** Source-aware flows exercise real routing/providers while replacing only the typed HTTP boundary. */
import { afterEach, expect, test } from 'bun:test';
import { onlineManager } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  waitFor,
  within,
  type BoundFunctions,
  type queries,
} from '@testing-library/react';
import type { Api } from '../../../data/api';
import { ApiError } from '../../../data/errors';
import { keys } from '../../../data/keys';
import { Outlet } from '../../../app/outlet';
import { SessionGate } from '../../session/session';
import { WorkspaceScopeProvider } from '../../shell/workspace';
import { SettingsScreen } from '../settings-screen';
import { installDom } from '../../../testing/dom';
import { renderApp } from '../../../testing/render';
import {
  aSession,
  aSignedInApi,
  aUser,
  aChannel,
  ALICE,
  BOB,
  IDS,
  WHEN,
  WORKSPACE,
} from '../../../testing/fixtures';
import { expectNoAxeViolations } from '../../../testing/axe';
import { person } from '../../../testing/user';
import type {
  WorkspaceAccessRole,
  WorkspaceAccessGroup,
  WorkspaceAccessPerson,
  WorkspaceAccessSourceSummary,
  WorkspaceMemberAccess,
  WorkspaceAccessGrant,
} from '@purlay/types/workspace-provisioning';
import { ContentPortsContext } from '../../content/content-ports';
import { Toaster } from '../../../ui/toast';
import { sectionFor } from '../sections';

installDom();
type View = Awaited<ReturnType<typeof renderApp>>;
const views: View[] = [];
afterEach(() => {
  for (const view of views.splice(0)) {
    view.unmount();
    view.world.client.clear();
  }
});
const ROLE: WorkspaceAccessRole = {
  id: IDS.api,
  revision: IDS.alice,
  name: 'People coordinator',
  capabilities: ['members.invite', 'channel.members.manage'],
  retiredAt: null,
};
const GROUP: WorkspaceAccessGroup = {
  id: IDS.incidents,
  revision: IDS.bob,
  name: 'Customer support',
  kind: 'manual',
  directoryId: null,
  memberCount: 1,
  retiredAt: null,
};
const MANUAL: WorkspaceAccessSourceSummary = {
  id: IDS.deploys,
  revision: IDS.alice,
  kind: 'manual',
  state: 'active',
  builtinRole: 'member',
  effective: true,
  name: null,
  directoryId: null,
};
const DIRECTORY: WorkspaceAccessSourceSummary = {
  ...MANUAL,
  id: IDS.browse,
  kind: 'directory',
  name: 'Office directory',
  directoryId: IDS.dm,
};
const ACCESS: WorkspaceMemberAccess = {
  userId: IDS.alice,
  revision: IDS.bob,
  state: 'active',
  role: 'member',
  accessKind: 'member',
  workspaceCapabilities: [],
  sources: [MANUAL, DIRECTORY],
  groupCount: 1,
};
const PEOPLE: WorkspaceAccessPerson = { id: IDS.alice, user: ALICE, access: ACCESS };
const GRANT: WorkspaceAccessGrant = {
  id: IDS.dm,
  revision: IDS.me,
  roleId: ROLE.id,
  role: ROLE,
  subject: { kind: 'source', sourceId: MANUAL.id, source: MANUAL, user: ALICE },
  scope: { kind: 'workspace' },
  createdAt: WHEN,
};
const open = async (
  path = 'access-roles',
  overrides: Partial<Api> = {},
  locale: 'en' | 'tr' = 'en',
): Promise<View> => {
  const view = await renderApp(
    <ContentPortsContext.Provider
      value={{ highlight: () => Promise.resolve(null), copy: () => Promise.resolve() }}
    >
      <Outlet />
      <Toaster dismissLabel="Close" />
    </ContentPortsContext.Provider>,
    {
      path: `/w/acme/settings/${path}`,
      locale,
      api: aSignedInApi({
        workspaceAccessRoles: () => Promise.resolve({ data: [ROLE], nextCursor: null }),
        workspaceAccessGroups: () => Promise.resolve({ data: [GROUP], nextCursor: null }),
        workspaceAccessPeople: () => Promise.resolve({ data: [PEOPLE], nextCursor: null }),
        workspaceMemberAccess: () => Promise.resolve(ACCESS),
        workspaceAccessGrants: () => Promise.resolve({ data: [], nextCursor: null }),
        workspaceAccessGroupMembers: () => Promise.resolve({ data: [], nextCursor: null }),
        ...overrides,
      }),
    },
  );
  views.push(view);
  view.world.client.setDefaultOptions({ queries: { retry: false } });
  return view;
};
const dialog = async (view: View, name: string): Promise<BoundFunctions<typeof queries>> =>
  within(await view.findByRole('dialog', { name }));
const required = <T,>(value: T | undefined): T => {
  if (value === undefined) throw new Error('Expected an available choice');
  return value;
};

test('each access list renders pending, retryable error and empty states', async () => {
  for (const [page, method] of [
    ['access-roles', 'workspaceAccessRoles'],
    ['access-groups', 'workspaceAccessGroups'],
    ['access-people', 'workspaceAccessPeople'],
  ] as const) {
    let reject: (error: Error) => void = () => undefined;
    let first = true;
    const api = {
      [method]: (): Promise<{ data: never[]; nextCursor: null }> =>
        first
          ? new Promise<never>((_accept, refuse): void => {
              reject = refuse;
            })
          : Promise.resolve({ data: [], nextCursor: null }),
    };
    const view = await open(page, api);
    await view.findByRole('heading', {
      level: 1,
      name:
        page === 'access-roles'
          ? 'Roles'
          : page === 'access-groups'
            ? 'Access groups'
            : 'People access',
    });
    await view.findByText('Loading');
    act(() => {
      first = false;
      reject(new ApiError(403, 'FORBIDDEN', 'denied'));
    });
    await person().click(await view.findByRole('button', { name: 'Retry' }));
    await view.findByText('No results. Try a different search or create the first item.');
    view.unmount();
    view.world.client.clear();
  }
});

test('roles validate finite actions, create, edit and retire with exact revisions', async () => {
  const calls: unknown[] = [];
  const view = await open('access-roles', {
    createWorkspaceAccessRole: (_id, input) => {
      calls.push(input);
      return Promise.resolve(ROLE);
    },
    updateWorkspaceAccessRole: (_id, id, input) => {
      calls.push({ id, ...input });
      return Promise.resolve(ROLE);
    },
    retireWorkspaceAccessRole: (_id, id, input) => {
      calls.push({ id, ...input });
      return Promise.resolve();
    },
  });
  await person().click(await view.findByRole('button', { name: 'Create role' }));
  let form = await dialog(view, 'Create role');
  await person().click(form.getByRole('button', { name: 'Save' }));
  form.getByText('Enter a name and choose at least one action.');
  await person().type(form.getByRole('textbox', { name: 'Name' }), 'Recruiter');
  await person().click(form.getByRole('checkbox', { name: 'Invite people to the workspace' }));
  await expectNoAxeViolations(view.getByRole('dialog'));
  await person().click(form.getByRole('button', { name: 'Save' }));
  await waitFor(() => {
    expect(view.queryAllByRole('dialog')).toHaveLength(0);
  });
  await person().click(view.getByRole('button', { name: 'Edit' }));
  form = await dialog(view, 'Edit role');
  await person().clear(form.getByRole('textbox', { name: 'Name' }));
  await person().type(form.getByRole('textbox', { name: 'Name' }), 'Coordinator');
  await person().click(form.getByRole('button', { name: 'Save' }));
  await waitFor(() => {
    expect(view.queryAllByRole('dialog')).toHaveLength(0);
  });
  await person().click(view.getByRole('button', { name: 'Retire' }));
  form = await dialog(view, 'Retire People coordinator?');
  await person().click(form.getByRole('button', { name: 'Retire' }));
  await waitFor(() => {
    expect(calls).toHaveLength(3);
  });
  expect(calls).toEqual([
    { name: 'Recruiter', capabilities: ['members.invite'] },
    { id: ROLE.id, revision: ROLE.revision, name: 'Coordinator', capabilities: ROLE.capabilities },
    { id: ROLE.id, revision: ROLE.revision },
  ]);
});

test('a failed refresh retains role rows while disabling writes and stale revisions get recovery copy', async () => {
  let failRead = false;
  const view = await open('access-roles', {
    workspaceAccessRoles: () =>
      failRead
        ? Promise.reject(new ApiError(403, 'FORBIDDEN', 'denied'))
        : Promise.resolve({ data: [ROLE], nextCursor: null }),
    updateWorkspaceAccessRole: () =>
      Promise.reject(new ApiError(409, 'WORKSPACE_PROVISIONING_CHANGED', 'changed')),
  });
  await person().click(await view.findByRole('button', { name: 'Edit' }));
  const form = await dialog(view, 'Edit role');
  await person().click(form.getByRole('button', { name: 'Save' }));
  await form.findByText(
    'Access changed. Close this panel, refresh and review the current details before trying again.',
  );
  await person().click(form.getByRole('button', { name: 'Cancel' }));
  failRead = true;
  await act(async () => {
    await view.world.client.invalidateQueries({ queryKey: ['workspace-provisioning'] });
  });
  expect(view.getByText(ROLE.name)).toBeDefined();
  await waitFor(() => {
    expect((view.getByRole('button', { name: 'Create role' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
  expect((view.getByRole('button', { name: 'Edit' }) as HTMLButtonElement).disabled).toBe(true);
});

test('people search and state filters use server keysets, preserving earlier pages', async () => {
  const seen: unknown[] = [];
  const view = await open('access-people', {
    workspaceAccessPeople: (_id, query) => {
      seen.push(query);
      return Promise.resolve({
        data: [
          {
            ...PEOPLE,
            id: query?.before === undefined ? IDS.alice : IDS.bob,
            user: query?.before === undefined ? ALICE : BOB,
          },
        ],
        nextCursor: query?.before === undefined ? IDS.bob : null,
      });
    },
  });
  await person().click(await view.findByRole('button', { name: 'Show more' }));
  await view.findByText('Bob');
  expect(view.getByText('Alice')).toBeDefined();
  await person().type(view.getByRole('searchbox', { name: 'Find by name or handle' }), 'Acme');
  await person().click(view.getByRole('button', { name: 'Search' }));
  await waitFor(() => {
    expect(seen).toContainEqual({ limit: 40, q: 'Acme' });
  });
  fireEvent.change(view.getByRole('combobox', { name: 'Access state' }), {
    target: { value: 'offboarded' },
  });
  await waitFor(() => {
    expect(seen).toContainEqual({ limit: 40, q: 'Acme', state: 'offboarded' });
  });
  expect(seen).toContainEqual({ limit: 40, q: '', before: IDS.bob });
});

test('source revocation binds the source revision and preserves an independent directory source', async () => {
  let access = ACCESS;
  const calls: unknown[] = [];
  const view = await open('access-people', {
    workspaceMemberAccess: () => Promise.resolve(access),
    revokeWorkspaceAccessSource: (_wid, uid, sid, input) => {
      calls.push({ uid, sid, ...input });
      access = {
        ...ACCESS,
        sources: [{ ...MANUAL, state: 'retired', effective: false }, DIRECTORY],
      };
      return Promise.resolve(access);
    },
  });
  await person().click(await view.findByRole('button', { name: 'Manage access' }));
  const sourceHeading = await view.findByRole('heading', { name: 'Admission sources' });
  expect(sourceHeading).toBeDefined();
  expect(view.container.textContent).not.toContain(IDS.alice);
  const revoke = view.getAllByRole('button', { name: 'Revoke source' }).at(0);
  if (revoke === undefined) throw new Error('Missing source revoke');
  await person().click(revoke);
  const form = await dialog(view, 'Revoke Manual access?');
  await person().click(form.getByRole('button', { name: 'Revoke source' }));
  await waitFor(() => {
    expect(view.queryAllByRole('dialog')).toHaveLength(0);
  });
  expect(calls).toEqual([{ uid: IDS.alice, sid: MANUAL.id, revision: MANUAL.revision }]);
  expect(view.getByText('Office directory')).toBeDefined();
  expect(view.getAllByText('Contributes to current access')).toHaveLength(1);
});

test('offboarding requires its preview and readmission never silently creates manual access', async () => {
  let access = ACCESS;
  const seen: unknown[] = [];
  let manual = 0;
  const view = await open('access-people', {
    workspaceMemberAccess: () => Promise.resolve(access),
    addManualWorkspaceAccess: () => {
      manual++;
      return Promise.resolve(ACCESS);
    },
    previewWorkspaceOffboarding: (_id, uid, input) => {
      seen.push({ preview: uid, ...input });
      return Promise.resolve({
        access: ACCESS,
        affectedChannelCount: 12,
        sourceSessionCount: 3,
        canOffboard: true,
        reason: null,
      });
    },
    confirmWorkspaceOffboarding: (_id, uid, input) => {
      seen.push({ offboard: uid, ...input });
      access = { ...ACCESS, revision: IDS.me, state: 'offboarded', role: null };
      return Promise.resolve(access);
    },
    readmitWorkspaceMember: (_id, uid, input) => {
      seen.push({ readmit: uid, ...input });
      access = { ...ACCESS, revision: IDS.alice, state: 'inactive', sources: [] };
      return Promise.resolve(access);
    },
  });
  await person().click(await view.findByRole('button', { name: 'Manage access' }));
  await person().click(await view.findByRole('button', { name: 'Preview offboarding' }));
  let form = await dialog(view, 'Offboard Alice?');
  form.getByText('Affected channels: 12. Applicable sessions: 3.');
  await person().click(form.getByRole('button', { name: 'Offboard person' }));
  await person().click(await view.findByRole('button', { name: 'Allow readmission' }));
  form = await dialog(view, 'Allow Alice to return?');
  await person().click(form.getByRole('button', { name: 'Allow readmission' }));
  await view.findByText('No admission sources.');
  expect(seen).toEqual([
    { preview: IDS.alice, revision: ACCESS.revision },
    { offboard: IDS.alice, revision: ACCESS.revision, confirm: true },
    { readmit: IDS.alice, revision: IDS.me, confirm: true },
  ]);
  expect(manual).toBe(0);
});

test('manual admission is explicit and native admin never offers an owner grant', async () => {
  const session = aSession();
  const sent: unknown[] = [];
  const view = await open('access-people', {
    me: () =>
      Promise.resolve({
        ...session,
        memberships: session.memberships.map((membership) => ({ ...membership, role: 'admin' })),
      }),
    addManualWorkspaceAccess: (_id, uid, input) => {
      sent.push({ uid, ...input });
      return Promise.resolve(ACCESS);
    },
  });
  await person().click(await view.findByRole('button', { name: 'Manage access' }));
  await person().click(await view.findByRole('button', { name: 'Manage manual access' }));
  const form = await dialog(view, 'Manage manual access');
  expect(form.queryByRole('option', { name: 'Owner' })).toBeNull();
  await person().click(form.getByRole('button', { name: 'Save manual access' }));
  await waitFor(() => {
    expect(sent).toEqual([{ uid: IDS.alice, revision: ACCESS.revision, role: 'member' }]);
  });
});

test('group candidates are human-readable exact source choices, with bounded search and revision changes', async () => {
  const sent: unknown[] = [];
  const view = await open('access-groups', {
    workspaceAccessGroupCandidates: (_wid, gid, query) => {
      sent.push({ candidates: gid, ...query });
      return Promise.resolve({
        data: [
          { id: MANUAL.id, user: ALICE, source: MANUAL },
          { id: DIRECTORY.id, user: ALICE, source: DIRECTORY },
        ],
        nextCursor: null,
      });
    },
    updateWorkspaceAccessGroupMembers: (_wid, gid, input) => {
      sent.push({ update: gid, ...input });
      return Promise.resolve(GROUP);
    },
  });
  await person().click(await view.findByRole('button', { name: 'View group' }));
  await person().click(await view.findByRole('button', { name: 'Add people sources' }));
  const form = await dialog(view, 'Add people sources');
  await form.findByText('Admission sources');
  const choices = form.getAllByRole('checkbox');
  expect(choices).toHaveLength(2);
  const directoryChoice = choices.at(1);
  if (directoryChoice === undefined) throw new Error('Missing directory choice');
  await person().click(directoryChoice);
  await person().click(form.getByRole('button', { name: 'Add selected (1)' }));
  await waitFor(() => {
    expect(sent).toContainEqual({
      update: GROUP.id,
      revision: GROUP.revision,
      addSourceIds: [DIRECTORY.id],
    });
  });
  expect(sent).toContainEqual({ candidates: GROUP.id, limit: 40, q: '' });
});

test('directory groups retain source visibility and grants while local membership edits stay absent', async () => {
  const view = await open('access-groups', {
    workspaceAccessGroups: () =>
      Promise.resolve({
        data: [{ ...GROUP, kind: 'directory', directoryId: IDS.dm }],
        nextCursor: null,
      }),
    workspaceAccessGroupMembers: () =>
      Promise.resolve({
        data: [
          {
            id: IDS.api,
            userId: IDS.alice,
            user: ALICE,
            sourceId: DIRECTORY.id,
            source: DIRECTORY,
            joinedAt: WHEN,
          },
        ],
        nextCursor: null,
      }),
  });
  await person().click(await view.findByRole('button', { name: 'View group' }));
  await view.findByText('Alice');
  expect(view.queryByRole('button', { name: 'Add people sources' })).toBeNull();
  expect(view.queryByRole('button', { name: 'Remove source from group' })).toBeNull();
  expect(view.queryByRole('button', { name: 'Edit' })).toBeNull();
  expect(view.getByRole('button', { name: 'Assign role' })).toBeDefined();
});

test('mixed roles apply only compatible actions; a channel grant offers visible non-DM channels and adds no membership', async () => {
  const sent: unknown[] = [];
  let membershipWrites = 0;
  const view = await open('access-people', {
    channels: () =>
      Promise.resolve([
        aChannel(IDS.api, 'help'),
        aChannel(IDS.dm, null, { type: 'direct_message' }),
      ]),
    assignWorkspaceAccessGrant: (_id, input) => {
      sent.push(input);
      return Promise.resolve(GRANT);
    },
    addChannelMember: () => {
      membershipWrites++;
      return Promise.resolve();
    },
  });
  await person().click(await view.findByRole('button', { name: 'Manage access' }));
  const grant = (await view.findAllByRole('button', { name: 'Role grants' })).at(0);
  if (grant === undefined) throw new Error('Missing source grants');
  await person().click(grant);
  await person().click(await view.findByRole('button', { name: 'Assign role' }));
  const form = await dialog(view, 'Assign role');
  await form.findByRole('radio');
  expect(form.queryByText('Manage channel members')).toBeNull();
  fireEvent.change(form.getByRole('combobox', { name: 'Scope' }), { target: { value: 'channel' } });
  await form.findByText('Manage channel members');
  expect(form.queryByText('Invite people to the workspace')).toBeNull();
  const channel = form.getByRole('combobox', { name: 'Channel' });
  expect(
    within(channel)
      .getAllByRole('option')
      .map((option) => option.textContent),
  ).toEqual(['Choose a visible channel', '#help']);
  fireEvent.change(channel, { target: { value: IDS.api } });
  await person().click(form.getByRole('radio'));
  await person().click(form.getByRole('button', { name: 'Assign role' }));
  await waitFor(() => {
    expect(sent).toEqual([
      {
        roleId: ROLE.id,
        roleRevision: ROLE.revision,
        subject: { kind: 'source', sourceId: MANUAL.id },
        subjectRevision: MANUAL.revision,
        scope: { kind: 'channel', channelId: IDS.api },
      },
    ]);
  });
  expect(membershipWrites).toBe(0);
});

test('capabilities reveal only matching settings pages and never reveal access administration', async () => {
  for (const id of [
    'access-people',
    'access-roles',
    'access-groups',
    'directory',
    'company',
    'security',
    'data',
  ])
    expect(
      sectionFor(
        id,
        'member',
        false,
        ['chat'],
        ['members.invite', 'members.manage_nonowners', 'audit.read'],
      ),
    ).toBeNull();
  expect(sectionFor('members', 'member', false, [], ['members.manage_nonowners'])?.id).toBe(
    'members',
  );
  expect(sectionFor('invitations', 'member', false, [], ['members.invite'])?.id).toBe(
    'invitations',
  );
  expect(sectionFor('audit', 'member', false, [], ['audit.read'])?.id).toBe('audit');
  expect(sectionFor('members', 'member', false, [])).toBeNull();
  const session = aSession();
  const view = await open('members', {
    me: () =>
      Promise.resolve({
        ...session,
        memberships: session.memberships.map((membership) => ({
          ...membership,
          role: 'member',
          workspaceCapabilities: ['members.manage_nonowners'],
        })),
      }),
    members: () =>
      Promise.resolve([
        {
          user: ALICE,
          role: 'member',
          joinedAt: WHEN,
          profile: { title: null, status: null, timeZone: null },
        },
        {
          user: BOB,
          role: 'admin',
          joinedAt: WHEN,
          profile: { title: null, status: null, timeZone: null },
        },
      ]),
  });
  await view.findByRole('button', { name: 'Remove Alice' });
  expect(view.queryByRole('button', { name: 'Remove Bob' })).toBeNull();
  expect(view.queryByRole('combobox', { name: /role of/i })).toBeNull();
  expect(view.queryByRole('link', { name: 'Invite people' })).toBeNull();
  act(() => {
    view.world.client.setQueryData(keys.me, {
      ...session,
      memberships: session.memberships.map((membership) => ({ ...membership, role: 'member' })),
    });
  });
  await view.findByRole('heading', { name: 'Nothing here' });
});

test('an account/workspace change discards an open access form and reads only current tenant data', async () => {
  const session = aSession();
  const sent: unknown[] = [];
  let current = session;
  const view = await renderApp(
    <SessionGate>
      <WorkspaceScopeProvider slug="acme" notFound={<p>Unavailable workspace</p>}>
        <SettingsScreen section="access-roles" />
      </WorkspaceScopeProvider>
    </SessionGate>,
    {
      api: aSignedInApi({
        me: () => Promise.resolve(current),
        workspaceAccessRoles: (wid) => {
          sent.push(wid);
          return Promise.resolve({ data: [ROLE], nextCursor: null });
        },
      }),
    },
  );
  views.push(view);
  await person().click(await view.findByRole('button', { name: 'Create role' }));
  const form = await dialog(view, 'Create role');
  await person().type(form.getByRole('textbox', { name: 'Name' }), 'old draft');
  const nextWorkspace = { ...WORKSPACE, id: IDS.browse };
  current = {
    ...session,
    user: { ...aUser('replacement', IDS.bob), email: 'new@example.test' },
    memberships: [{ workspace: nextWorkspace, role: 'owner', joinedAt: WHEN, deepWorkUntil: null }],
  };
  act(() => {
    view.world.client.setQueryData(keys.me, current);
  });
  await waitFor(() => {
    expect(view.queryAllByRole('dialog')).toHaveLength(0);
  });
  await waitFor(() => {
    expect(sent).toContain(IDS.browse);
  });
});

test('manual group creation, rename, source removal and retirement preserve explicit revision requests', async () => {
  const calls: unknown[] = [];
  const view = await open('access-groups', {
    createWorkspaceAccessGroup: (_wid, input) => {
      calls.push({ created: input });
      return Promise.resolve(GROUP);
    },
    updateWorkspaceAccessGroup: (_wid, gid, input) => {
      calls.push({ updated: gid, ...input });
      return Promise.resolve(GROUP);
    },
    workspaceAccessGroupMembers: () =>
      Promise.resolve({
        data: [
          {
            id: IDS.api,
            userId: IDS.alice,
            user: ALICE,
            sourceId: MANUAL.id,
            source: MANUAL,
            joinedAt: WHEN,
          },
        ],
        nextCursor: null,
      }),
    updateWorkspaceAccessGroupMembers: (_wid, gid, input) => {
      calls.push({ members: gid, ...input });
      return Promise.resolve(GROUP);
    },
    retireWorkspaceAccessGroup: (_wid, gid, input) => {
      calls.push({ retired: gid, ...input });
      return Promise.resolve();
    },
  });
  await person().click(await view.findByRole('button', { name: 'Create access group' }));
  let form = await dialog(view, 'Create access group');
  await person().click(form.getByRole('button', { name: 'Save' }));
  form.getByText('Enter a name of up to 64 characters.');
  await person().type(form.getByRole('textbox', { name: 'Name' }), 'Branch team');
  await person().click(form.getByRole('button', { name: 'Save' }));
  await waitFor(() => {
    expect(view.queryAllByRole('dialog')).toHaveLength(0);
  });
  await person().click(view.getByRole('button', { name: 'Edit' }));
  form = await dialog(view, 'Rename access group');
  await person().clear(form.getByRole('textbox', { name: 'Name' }));
  await person().type(form.getByRole('textbox', { name: 'Name' }), 'Branch support');
  await person().click(form.getByRole('button', { name: 'Save' }));
  await waitFor(() => {
    expect(view.queryAllByRole('dialog')).toHaveLength(0);
  });
  await person().click(view.getByRole('button', { name: 'View group' }));
  await person().click(await view.findByRole('button', { name: 'Remove source from group' }));
  form = await dialog(view, 'Remove Alice from this group?');
  await person().click(form.getByRole('button', { name: 'Remove source from group' }));
  await waitFor(() => {
    expect(view.queryAllByRole('dialog')).toHaveLength(0);
  });
  await person().click(view.getByRole('button', { name: 'Retire' }));
  form = await dialog(view, 'Retire Customer support?');
  await person().click(form.getByRole('button', { name: 'Retire' }));
  await waitFor(() => {
    expect(calls).toEqual([
      { created: { name: 'Branch team' } },
      { updated: GROUP.id, revision: GROUP.revision, name: 'Branch support' },
      { members: GROUP.id, revision: GROUP.revision, removeSourceIds: [MANUAL.id] },
      { retired: GROUP.id, revision: GROUP.revision },
    ]);
  });
});

test('revoking a scoped role changes only the selected grant and uses its observed revision', async () => {
  const seen: unknown[] = [];
  const view = await open('access-people', {
    workspaceAccessGrants: (_wid, query) => {
      seen.push({ read: query });
      return Promise.resolve({ data: [GRANT], nextCursor: null });
    },
    revokeWorkspaceAccessGrant: (_wid, gid, input) => {
      seen.push({ revoked: gid, ...input });
      return Promise.resolve();
    },
  });
  await person().click(await view.findByRole('button', { name: 'Manage access' }));
  const grants = (await view.findAllByRole('button', { name: 'Role grants' })).at(0);
  if (grants === undefined) throw new Error('Missing source grant action');
  await person().click(grants);
  await person().click(await view.findByRole('button', { name: 'Revoke role' }));
  const form = await dialog(view, 'Revoke People coordinator?');
  await person().click(form.getByRole('button', { name: 'Revoke role' }));
  await waitFor(() => {
    expect(seen).toContainEqual({ revoked: GRANT.id, revision: GRANT.revision });
  });
  expect(seen).toContainEqual({ read: { limit: 40, sourceId: MANUAL.id } });
});

test('a delegated channel manager reaches scoped archives in General without workspace administration controls', async () => {
  const session = aSession();
  const restored: string[] = [];
  const view = await open('general', {
    me: () =>
      Promise.resolve({
        ...session,
        memberships: session.memberships.map((membership) => ({
          ...membership,
          role: 'member',
          channelCapabilities: ['channel.settings.manage'],
        })),
      }),
    archivedChannels: () =>
      Promise.resolve([{ id: IDS.api, name: 'scoped-archive', type: 'public', archivedAt: WHEN }]),
    restoreChannel: (id) => {
      restored.push(id);
      return Promise.resolve();
    },
  });
  await view.findByRole('link', { name: 'General' });
  await view.findByText(/#scoped-archive/);
  expect(view.queryByRole('textbox', { name: 'Workspace name' })).toBeNull();
  expect(view.queryByRole('button', { name: 'Save workspace name' })).toBeNull();
  expect(view.queryByRole('button', { name: 'Create workspace' })).toBeNull();
  expect(view.queryByRole('button', { name: 'Delete workspace' })).toBeNull();
  await person().click(view.getByRole('button', { name: 'Restore' }));
  await waitFor(() => {
    expect(restored).toEqual([IDS.api]);
  });
});

test('an offline confirmation sends no write, stays dismissible and requires an explicit retry after reconnect', async () => {
  let writes = 0;
  const view = await open('access-roles', {
    retireWorkspaceAccessRole: () => {
      writes++;
      return Promise.resolve();
    },
  });
  await person().click(await view.findByRole('button', { name: 'Retire' }));
  let form = await dialog(view, 'Retire People coordinator?');
  try {
    act(() => {
      onlineManager.setOnline(false);
    });
    await person().click(form.getByRole('button', { name: 'Retire' }));
    await form.findByText('Check your connection and try again.');
    expect(writes).toBe(0);
    expect(form.getByRole<HTMLButtonElement>('button', { name: 'Cancel' }).disabled).toBe(false);
    await person().keyboard('{Escape}');
    await waitFor(() => {
      expect(view.queryAllByRole('dialog')).toHaveLength(0);
    });
    act(() => {
      onlineManager.setOnline(true);
    });
    await act(async () => {
      await view.world.client.resumePausedMutations();
    });
    expect(writes).toBe(0);
    await person().click(view.getByRole('button', { name: 'Retire' }));
    form = await dialog(view, 'Retire People coordinator?');
    expect(writes).toBe(0);
    await person().click(form.getByRole('button', { name: 'Retire' }));
    await waitFor(() => {
      expect(writes).toBe(1);
    });
  } finally {
    onlineManager.setOnline(true);
  }
});

test('role paging and search keep retired roles readable, and an editor can remove an action or discard its draft', async () => {
  const reads: unknown[] = [];
  const writes: unknown[] = [];
  const view = await open('access-roles', {
    workspaceAccessRoles: (_wid, query) => {
      reads.push(query);
      return Promise.resolve({
        data: query?.q
          ? []
          : query?.before === undefined
            ? [ROLE]
            : [{ ...ROLE, id: IDS.bob, name: 'Retired coordinator', retiredAt: WHEN }],
        nextCursor: query?.before === undefined && !query?.q ? IDS.bob : null,
      });
    },
    updateWorkspaceAccessRole: (_wid, id, input) => {
      writes.push({ id, ...input });
      return Promise.resolve(ROLE);
    },
  });
  await person().click(await view.findByRole('button', { name: 'Show more' }));
  await view.findByText('Retired coordinator');
  expect(view.getAllByRole('button', { name: 'Edit' })).toHaveLength(1);
  await person().click(view.getByRole('button', { name: 'Edit' }));
  let form = await dialog(view, 'Edit role');
  await person().click(form.getByRole('checkbox', { name: 'Manage channel members' }));
  await person().click(form.getByRole('button', { name: 'Save' }));
  await waitFor(() => {
    expect(writes).toEqual([
      { id: ROLE.id, revision: ROLE.revision, name: ROLE.name, capabilities: ['members.invite'] },
    ]);
  });
  await waitFor(() => {
    expect(view.queryAllByRole('dialog')).toHaveLength(0);
  });
  await person().click(view.getByRole('button', { name: 'Create role' }));
  form = await dialog(view, 'Create role');
  await person().type(form.getByRole('textbox', { name: 'Name' }), 'Discarded role');
  await person().keyboard('{Escape}');
  await waitFor(() => {
    expect(view.queryAllByRole('dialog')).toHaveLength(0);
  });
  await person().type(view.getByRole('searchbox', { name: 'Find by name' }), 'missing');
  await person().click(view.getByRole('button', { name: 'Search' }));
  await view.findByText('No results. Try a different search or create the first item.');
  expect(reads).toContainEqual({ limit: 40, q: '', before: IDS.bob });
  expect(reads).toContainEqual({ limit: 40, q: 'missing' });
  expect(writes).toHaveLength(1);
});

test('group lists and member lists page and search independently, and cancelling removal or retirement writes nothing', async () => {
  const reads: unknown[] = [];
  let writes = 0;
  const view = await open('access-groups', {
    workspaceAccessGroups: (_wid, query) => {
      reads.push({ groups: query });
      return Promise.resolve({
        data:
          query?.before === undefined
            ? [GROUP]
            : [{ ...GROUP, id: IDS.bob, name: 'Retired team', retiredAt: WHEN }],
        nextCursor: query?.before === undefined ? IDS.bob : null,
      });
    },
    workspaceAccessGroupMembers: (_wid, gid, query) => {
      reads.push({ members: gid, ...query });
      return Promise.resolve({
        data: [
          {
            id: query?.before === undefined ? IDS.api : IDS.bob,
            userId: IDS.alice,
            user: query?.before === undefined ? ALICE : BOB,
            sourceId: MANUAL.id,
            source: MANUAL,
            joinedAt: WHEN,
          },
        ],
        nextCursor: query?.before === undefined ? IDS.bob : null,
      });
    },
    updateWorkspaceAccessGroupMembers: () => {
      writes++;
      return Promise.resolve(GROUP);
    },
    retireWorkspaceAccessGroup: () => {
      writes++;
      return Promise.resolve();
    },
  });
  await person().click(await view.findByRole('button', { name: 'Show more' }));
  await view.findByText('Retired team');
  await person().click(required(view.getAllByRole('button', { name: 'View group' })[0]));
  await view.findByText('Alice');
  await person().click(view.getByRole('button', { name: 'Show more' }));
  await view.findByText('Bob');
  await person().type(view.getByRole('searchbox', { name: 'Find by name or handle' }), 'Alice');
  const searches = view.getAllByRole('button', { name: 'Search' });
  await person().click(required(searches.at(-1)));
  await waitFor(() => {
    expect(reads).toContainEqual({ members: GROUP.id, limit: 40, q: 'Alice' });
  });
  await person().click(
    required(view.getAllByRole('button', { name: 'Remove source from group' })[0]),
  );
  await person().click(
    (await dialog(view, 'Remove Alice from this group?')).getByRole('button', { name: 'Cancel' }),
  );
  await person().click(view.getByRole('button', { name: 'Retire' }));
  await person().click(
    (await dialog(view, 'Retire Customer support?')).getByRole('button', { name: 'Cancel' }),
  );
  expect(writes).toBe(0);
  await person().click(view.getByRole('button', { name: 'Edit' }));
  await dialog(view, 'Rename access group');
  await person().keyboard('{Escape}');
  await waitFor(() => {
    expect(view.queryAllByRole('dialog')).toHaveLength(0);
  });
  await person().click(view.getByRole('button', { name: 'Create access group' }));
  await person().click(
    (await dialog(view, 'Create access group')).getByRole('button', { name: 'Cancel' }),
  );
  await person().type(view.getByRole('searchbox', { name: 'Find by name' }), 'support');
  await person().click(required(view.getAllByRole('button', { name: 'Search' })[0]));
  await waitFor(() => {
    expect(view.queryByText('Admission sources')).toBeNull();
  });
});

test('group candidates recover a refusal, page exact sources, and search clears an unsubmitted selection', async () => {
  let fail = true;
  let writes = 0;
  const reads: unknown[] = [];
  const view = await open('access-groups', {
    workspaceAccessGroupCandidates: (_wid, _gid, query) => {
      reads.push(query);
      return fail
        ? Promise.reject(new ApiError(403, 'FORBIDDEN', 'denied'))
        : Promise.resolve({
            data: [
              {
                id: query?.before === undefined ? MANUAL.id : DIRECTORY.id,
                user: query?.before === undefined ? ALICE : BOB,
                source: query?.before === undefined ? MANUAL : DIRECTORY,
              },
            ],
            nextCursor: query?.before === undefined ? IDS.bob : null,
          });
    },
    updateWorkspaceAccessGroupMembers: () => {
      writes++;
      return Promise.resolve(GROUP);
    },
  });
  await person().click(await view.findByRole('button', { name: 'View group' }));
  await person().click(await view.findByRole('button', { name: 'Add people sources' }));
  let form = await dialog(view, 'Add people sources');
  fail = false;
  await person().click(await form.findByRole('button', { name: 'Retry' }));
  await person().click(await form.findByRole('checkbox'));
  await person().click(form.getByRole('checkbox'));
  expect(form.getByRole<HTMLButtonElement>('button', { name: 'Add selected (0)' }).disabled).toBe(
    true,
  );
  await person().click(form.getByRole('button', { name: 'Show more' }));
  await form.findByText('Bob');
  await person().click(required(form.getAllByRole('checkbox')[1]));
  await person().type(form.getByRole('searchbox', { name: 'Find by name or handle' }), 'Bob');
  await person().click(form.getByRole('button', { name: 'Search' }));
  await waitFor(() => {
    expect(reads).toContainEqual({ limit: 40, q: 'Bob' });
  });
  expect(form.getByRole<HTMLButtonElement>('button', { name: 'Add selected (0)' }).disabled).toBe(
    true,
  );
  await person().keyboard('{Escape}');
  await waitFor(() => {
    expect(view.queryAllByRole('dialog')).toHaveLength(0);
  });
  await person().click(view.getByRole('button', { name: 'Add people sources' }));
  form = await dialog(view, 'Add people sources');
  await person().click(form.getByRole('button', { name: 'Cancel' }));
  expect(writes).toBe(0);
  expect(reads).toContainEqual({ limit: 40, q: '', before: IDS.bob });
});

test('grants recover read failures and page workspace/channel scopes without revoking a cancelled choice', async () => {
  let fail = true;
  let writes = 0;
  const reads: unknown[] = [];
  const view = await open('access-groups', {
    workspaceAccessGrants: (_wid, query) => {
      reads.push(query);
      return fail
        ? Promise.reject(new ApiError(403, 'FORBIDDEN', 'denied'))
        : Promise.resolve({
            data: [
              query?.before === undefined
                ? {
                    ...GRANT,
                    subject: { kind: 'group' as const, groupId: GROUP.id, group: GROUP },
                    scope: {
                      kind: 'channel' as const,
                      channelId: IDS.api,
                      name: 'help',
                      type: 'public' as const,
                    },
                  }
                : { ...GRANT, id: IDS.bob },
            ],
            nextCursor: query?.before === undefined ? IDS.bob : null,
          });
    },
    revokeWorkspaceAccessGrant: () => {
      writes++;
      return Promise.resolve();
    },
  });
  await person().click(await view.findByRole('button', { name: 'View group' }));
  fail = false;
  await person().click(await view.findByRole('button', { name: 'Retry' }));
  await view.findByText('#help');
  await person().click(view.getByRole('button', { name: 'Show more' }));
  await waitFor(() => {
    expect(view.getAllByRole('button', { name: 'Revoke role' })).toHaveLength(2);
  });
  await person().click(required(view.getAllByRole('button', { name: 'Revoke role' })[0]));
  await person().click(
    (await dialog(view, 'Revoke People coordinator?')).getByRole('button', { name: 'Cancel' }),
  );
  expect(writes).toBe(0);
  expect(reads).toContainEqual({ limit: 40, groupId: GROUP.id, before: IDS.bob });
});

test('grant role choices recover, page and reset after search; only a reviewed compatible workspace grant is submitted', async () => {
  let fail = true;
  const reads: unknown[] = [];
  const sent: unknown[] = [];
  const view = await open('access-groups', {
    workspaceAccessRoles: (_wid, query) => {
      reads.push(query);
      return fail
        ? Promise.reject(new ApiError(403, 'FORBIDDEN', 'denied'))
        : Promise.resolve({
            data: [
              query?.before === undefined
                ? ROLE
                : { ...ROLE, id: IDS.bob, name: 'Other coordinator' },
            ],
            nextCursor: query?.before === undefined ? IDS.bob : null,
          });
    },
    channels: () => Promise.reject(new ApiError(403, 'FORBIDDEN', 'denied')),
    assignWorkspaceAccessGrant: (_wid, input) => {
      sent.push(input);
      return Promise.resolve(GRANT);
    },
  });
  await person().click(await view.findByRole('button', { name: 'View group' }));
  await person().click(await view.findByRole('button', { name: 'Assign role' }));
  let form = await dialog(view, 'Assign role');
  fail = false;
  await person().click(await form.findByRole('button', { name: 'Retry' }));
  await person().click(await form.findByRole('radio'));
  await person().click(form.getByRole('button', { name: 'Show more' }));
  await form.findByText('Other coordinator');
  await person().type(form.getByRole('searchbox', { name: 'Find a role' }), 'coordinator');
  await person().click(form.getByRole('button', { name: 'Search' }));
  await waitFor(() => {
    expect(form.getByRole<HTMLButtonElement>('button', { name: 'Assign role' }).disabled).toBe(
      true,
    );
  });
  fireEvent.change(form.getByRole('combobox', { name: 'Scope' }), { target: { value: 'channel' } });
  await form.findByText(
    'Couldn’t refresh access. The last known details are shown; changes are paused until you retry.',
  );
  expect(form.getByRole<HTMLButtonElement>('button', { name: 'Assign role' }).disabled).toBe(true);
  await person().keyboard('{Escape}');
  await waitFor(() => {
    expect(view.queryAllByRole('dialog')).toHaveLength(0);
  });
  await person().click(view.getByRole('button', { name: 'Assign role' }));
  form = await dialog(view, 'Assign role');
  await person().click(form.getByRole('button', { name: 'Cancel' }));
  await person().click(view.getByRole('button', { name: 'Assign role' }));
  form = await dialog(view, 'Assign role');
  await person().click(required((await form.findAllByRole('radio'))[0]));
  await person().click(form.getByRole('button', { name: 'Assign role' }));
  await waitFor(() => {
    expect(sent).toEqual([
      {
        roleId: ROLE.id,
        roleRevision: ROLE.revision,
        subject: { kind: 'group', groupId: GROUP.id },
        subjectRevision: GROUP.revision,
        scope: { kind: 'workspace' },
      },
    ]);
  });
  expect(reads).toContainEqual({ limit: 40, q: '', before: IDS.bob });
  expect(reads).toContainEqual({ limit: 40, q: 'coordinator' });
});

test('person detail retries its own read and abandoned manual/source/readmission confirmations have no effect', async () => {
  let fail = true;
  let access = ACCESS;
  const sent: unknown[] = [];
  const view = await open('access-people', {
    workspaceMemberAccess: () =>
      fail ? Promise.reject(new ApiError(403, 'FORBIDDEN', 'denied')) : Promise.resolve(access),
    addManualWorkspaceAccess: (_wid, uid, input) => {
      sent.push({ uid, ...input });
      return Promise.resolve(ACCESS);
    },
    revokeWorkspaceAccessSource: () => {
      sent.push('revoked');
      return Promise.resolve(ACCESS);
    },
    readmitWorkspaceMember: () => {
      sent.push('readmitted');
      return Promise.resolve(ACCESS);
    },
  });
  await person().click(await view.findByRole('button', { name: 'Manage access' }));
  fail = false;
  await person().click(await view.findByRole('button', { name: 'Retry' }));
  await person().click(await view.findByRole('button', { name: 'Manage manual access' }));
  const form = await dialog(view, 'Manage manual access');
  fireEvent.change(form.getByRole('combobox', { name: 'Native workspace role' }), {
    target: { value: 'owner' },
  });
  await person().click(form.getByRole('button', { name: 'Save manual access' }));
  await waitFor(() => {
    expect(sent).toEqual([{ uid: IDS.alice, revision: ACCESS.revision, role: 'owner' }]);
  });
  await waitFor(() => {
    expect(view.queryAllByRole('dialog')).toHaveLength(0);
  });
  await person().click(view.getByRole('button', { name: 'Manage manual access' }));
  await dialog(view, 'Manage manual access');
  await person().keyboard('{Escape}');
  await waitFor(() => {
    expect(view.queryAllByRole('dialog')).toHaveLength(0);
  });
  await person().click(required(view.getAllByRole('button', { name: 'Revoke source' })[0]));
  await person().click(
    (await dialog(view, 'Revoke Manual access?')).getByRole('button', { name: 'Cancel' }),
  );
  const grant = required(view.getAllByRole('button', { name: 'Role grants' })[0]);
  await person().click(grant);
  await view.findByRole('button', { name: 'Assign role' });
  await person().click(grant);
  expect(view.queryByRole('button', { name: 'Assign role' })).toBeNull();
  access = { ...ACCESS, state: 'offboarded' };
  await act(async () => {
    await view.world.client.invalidateQueries({ queryKey: ['workspace-provisioning'] });
  });
  await person().click(await view.findByRole('button', { name: 'Allow readmission' }));
  await person().click(
    (await dialog(view, 'Allow Alice to return?')).getByRole('button', { name: 'Cancel' }),
  );
  expect(sent).toHaveLength(1);
});

test('offboarding refusals explain protected and last-owner cases, and cancelling a valid preview sends no confirmation', async () => {
  let reason: 'last_owner' | 'protected_role' | null = 'last_owner';
  let confirmed = 0;
  const view = await open('access-people', {
    previewWorkspaceOffboarding: () =>
      Promise.resolve({
        access: ACCESS,
        affectedChannelCount: 2,
        sourceSessionCount: 1,
        canOffboard: reason === null,
        reason,
      }),
    confirmWorkspaceOffboarding: () => {
      confirmed++;
      return Promise.resolve(ACCESS);
    },
  });
  await person().click(await view.findByRole('button', { name: 'Manage access' }));
  for (const refusal of ['last_owner', 'protected_role', null] as const) {
    reason = refusal;
    await person().click(view.getByRole('button', { name: 'Preview offboarding' }));
    const form = await dialog(view, 'Offboard Alice?');
    expect(form.getByRole<HTMLButtonElement>('button', { name: 'Offboard person' }).disabled).toBe(
      refusal !== null,
    );
    if (refusal === 'last_owner')
      form.getByText('Add another owner before offboarding the last owner.');
    if (refusal === 'protected_role')
      form.getByText('Your native role cannot offboard this person.');
    if (refusal === null) await person().click(form.getByRole('button', { name: 'Cancel' }));
    else await person().keyboard('{Escape}');
    await waitFor(() => {
      expect(view.queryAllByRole('dialog')).toHaveLength(0);
    });
  }
  expect(confirmed).toBe(0);
  fireEvent.change(view.getByRole('combobox', { name: 'Access state' }), {
    target: { value: 'all' },
  });
  await waitFor(() => {
    expect(view.queryByRole('button', { name: 'Preview offboarding' }) === null).toBe(true);
  });
  await person().click(view.getByRole('button', { name: 'Manage access' }));
  await view.findByRole('button', { name: 'Preview offboarding' });
  await person().click(view.getByRole('button', { name: 'Manage access' }));
  expect(view.queryByRole('button', { name: 'Preview offboarding' }) === null).toBe(true);
});

test('guest access cannot reuse a channel-management hint to open workspace archives', async () => {
  const session = aSession();
  let reads = 0;
  const view = await open('general', {
    me: () =>
      Promise.resolve({
        ...session,
        memberships: session.memberships.map((m) => ({
          ...m,
          role: 'member',
          access: { kind: 'guest', historySince: WHEN, expiresAt: null },
          channelCapabilities: ['channel.settings.manage'],
        })),
      }),
    archivedChannels: () => {
      reads++;
      return Promise.resolve([]);
    },
  });
  await view.findByRole('heading', { name: 'Nothing here' });
  expect(view.queryByRole('button', { name: 'Restore' })).toBeNull();
  expect(reads).toBe(0);
});
