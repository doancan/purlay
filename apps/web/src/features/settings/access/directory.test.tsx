/** Directory UI holds issued secrets only in the mounted display and makes identity mapping explicit. */
import { afterEach, expect, test } from 'bun:test';
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
import { aSession, aSignedInApi, IDS, WHEN } from '../../../testing/fixtures';
import { COMPANY_CONNECTION } from '../../../testing/company-identity';
import { expectNoAxeViolations } from '../../../testing/axe';
import { person } from '../../../testing/user';
import type {
  DirectoryCredential,
  WorkspaceDirectory,
  IssuedDirectoryCredential,
} from '@purlay/types/workspace-directory';
import { ContentPortsContext } from '../../content/content-ports';
import { Toaster } from '../../../ui/toast';

installDom();
type View = Awaited<ReturnType<typeof renderApp>>;
const views: View[] = [];
afterEach(() => {
  for (const view of views.splice(0)) {
    view.unmount();
    view.world.client.clear();
  }
});
const CREDENTIAL: DirectoryCredential = {
  id: IDS.api,
  createdAt: WHEN,
  expiresAt: '2099-12-12T08:00:00.000Z',
  revokedAt: null,
  lastUsedAt: null,
};
const DIRECTORY: WorkspaceDirectory = {
  id: IDS.browse,
  revision: IDS.me,
  name: 'Office directory',
  enabled: true,
  allowCreate: false,
  connectionId: COMPANY_CONNECTION.id,
  claim: 'sub',
  scimUrl: `https://purlay.test/scim/v2/${IDS.browse}`,
  credentials: [],
  createdAt: WHEN,
  updatedAt: WHEN,
};
const ISSUED: IssuedDirectoryCredential = {
  directory: { ...DIRECTORY, revision: IDS.alice, credentials: [CREDENTIAL] },
  credential: CREDENTIAL,
  token: 'directory-secret-'.repeat(7),
};
const open = async (
  overrides: Partial<Api> = {},
  copy: (value: string) => Promise<void> = () => Promise.resolve(),
): Promise<View> => {
  const view = await renderApp(
    <ContentPortsContext.Provider value={{ highlight: () => Promise.resolve(null), copy }}>
      <Outlet />
      <Toaster dismissLabel="Close" />
    </ContentPortsContext.Provider>,
    {
      path: '/w/acme/settings/directory',
      api: aSignedInApi({
        workspaceDirectories: () => Promise.resolve({ data: [DIRECTORY], nextCursor: null }),
        companyConnections: () =>
          Promise.resolve({
            data: [{ ...COMPANY_CONNECTION, enabled: true, ready: true }],
            nextCursor: null,
          }),
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
const manage = async (view: View): Promise<void> => {
  await person().click(await view.findByRole('button', { name: 'Manage directory' }));
  await view.findByText('SCIM base URL');
};

test('directory reads handle loading, retryable failure and empty results', async () => {
  let reject: (error: Error) => void = () => undefined;
  let first = true;
  const view = await open({
    workspaceDirectories: () =>
      first
        ? new Promise<never>((_accept, refuse): void => {
            reject = refuse;
          })
        : Promise.resolve({ data: [], nextCursor: null }),
  });
  await view.findByRole('heading', { level: 1, name: 'Company directory' });
  await view.findByText('Loading');
  act(() => {
    first = false;
    reject(new ApiError(403, 'FORBIDDEN', 'denied'));
  });
  await person().click(await view.findByRole('button', { name: 'Retry' }));
  await view.findByText('No results. Try a different search or create the first item.');
});

test('directory creation fixes a verified connection and exact immutable claim without email linking', async () => {
  const seen: unknown[] = [];
  const view = await open({
    createWorkspaceDirectory: (_id, input) => {
      seen.push(input);
      return Promise.resolve(DIRECTORY);
    },
  });
  await person().click(await view.findByRole('button', { name: 'Add directory' }));
  const form = await dialog(view, 'Add directory');
  await form.findByRole('option', { name: 'Office' });
  await person().click(form.getByRole('button', { name: 'Save' }));
  form.getByText('Enter a name and choose an available verified connection and identity claim.');
  await person().type(form.getByRole('textbox', { name: 'Name' }), 'Staff directory');
  fireEvent.change(form.getByRole('combobox', { name: 'Company sign-in connection' }), {
    target: { value: COMPANY_CONNECTION.id },
  });
  fireEvent.change(form.getByRole('combobox', { name: 'Immutable identity claim' }), {
    target: { value: 'oid' },
  });
  await person().click(
    form.getByRole('checkbox', { name: 'Allow directory provisioning to create new accounts' }),
  );
  await expectNoAxeViolations(view.getByRole('dialog'));
  await person().click(form.getByRole('button', { name: 'Save' }));
  await waitFor(() => {
    expect(seen).toEqual([
      {
        name: 'Staff directory',
        connectionId: COMPANY_CONNECTION.id,
        claim: 'oid',
        allowCreate: true,
      },
    ]);
  });
});

test('unverified or unavailable company providers cannot be selected for a new directory', async () => {
  let failed = true;
  const view = await open({
    companyConnections: () =>
      failed
        ? Promise.reject(new ApiError(403, 'FORBIDDEN', 'denied'))
        : Promise.resolve({ data: [COMPANY_CONNECTION], nextCursor: null }),
  });
  await person().click(await view.findByRole('button', { name: 'Add directory' }));
  const form = await dialog(view, 'Add directory');
  await form.findByRole('button', { name: 'Retry' });
  failed = false;
  await person().click(form.getByRole('button', { name: 'Retry' }));
  await form.findByRole('link', { name: 'Set up and test company sign-in' });
  expect(form.queryByRole('option', { name: 'Office' })).toBeNull();
  expect(form.getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true);
});

test('credential rotation validates bounds and shows a secret once without storing it in Query or mutation results', async () => {
  let directory = DIRECTORY;
  const sent: unknown[] = [];
  const copied: string[] = [];
  const view = await open(
    {
      workspaceDirectories: () => Promise.resolve({ data: [directory], nextCursor: null }),
      rotateDirectoryCredential: (_wid, did, input) => {
        sent.push({ did, ...input });
        directory = ISSUED.directory;
        return Promise.resolve(ISSUED);
      },
    },
    (value) => {
      copied.push(value);
      return Promise.resolve();
    },
  );
  await manage(view);
  await person().click(view.getByRole('button', { name: 'Issue or rotate credential' }));
  let form = await dialog(view, 'Issue or rotate credential');
  await person().clear(form.getByRole('spinbutton', { name: 'Expires after (days)' }));
  await person().type(form.getByRole('spinbutton', { name: 'Expires after (days)' }), '0');
  await person().click(form.getByRole('button', { name: 'Issue credential' }));
  form.getByText('Use 1–365 days and 0–1,440 overlap minutes.');
  await person().clear(form.getByRole('spinbutton', { name: 'Expires after (days)' }));
  await person().type(form.getByRole('spinbutton', { name: 'Expires after (days)' }), '30');
  await person().clear(
    form.getByRole('spinbutton', { name: 'Keep previous credentials for (minutes)' }),
  );
  await person().type(
    form.getByRole('spinbutton', { name: 'Keep previous credentials for (minutes)' }),
    '15',
  );
  await person().click(form.getByRole('button', { name: 'Issue credential' }));
  form = await dialog(view, 'Save your directory token');
  await form.findByText(ISSUED.token);
  expect(
    JSON.stringify(
      view.world.client
        .getQueryCache()
        .getAll()
        .map((query) => [query.queryKey, query.state.data]),
    ),
  ).not.toContain(ISSUED.token);
  expect(
    JSON.stringify(
      view.world.client
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state.data),
    ),
  ).not.toContain(ISSUED.token);
  await person().click(form.getByRole('button', { name: 'Copy' }));
  expect(copied).toContain(ISSUED.token);
  await person().click(form.getByRole('button', { name: 'I saved this token' }));
  expect(view.queryByText(ISSUED.token)).toBeNull();
  await person().click(view.getByRole('button', { name: 'Edit directory' }));
  form = await dialog(view, 'Edit directory');
  expect(form.queryByRole('combobox')).toBeNull();
  await person().click(form.getByRole('button', { name: 'Cancel' }));
  expect(sent).toEqual([
    { did: DIRECTORY.id, revision: DIRECTORY.revision, expiresInDays: 30, overlapMinutes: 15 },
  ]);
});

test('expired and revoked credential metadata are terminal while only live credentials can be revoked', async () => {
  const revoked: DirectoryCredential = {
    ...CREDENTIAL,
    id: IDS.bob,
    revokedAt: WHEN,
    lastUsedAt: WHEN,
  };
  const expired: DirectoryCredential = {
    ...CREDENTIAL,
    id: IDS.alice,
    expiresAt: '2000-01-01T00:00:00.000Z',
  };
  const sent: unknown[] = [];
  const view = await open({
    workspaceDirectories: () =>
      Promise.resolve({
        data: [{ ...DIRECTORY, credentials: [CREDENTIAL, revoked, expired] }],
        nextCursor: null,
      }),
    revokeDirectoryCredential: (_id, did, input) => {
      sent.push({ did, ...input });
      return Promise.resolve(DIRECTORY);
    },
  });
  await manage(view);
  expect(view.getAllByRole('button', { name: 'Revoke credential' })).toHaveLength(1);
  expect(view.getByText(/^Expired /)).toBeDefined();
  expect(view.getByText(/^Revoked /)).toBeDefined();
  expect(view.getByText(/^Last used /)).toBeDefined();
  await person().click(view.getByRole('button', { name: 'Revoke credential' }));
  const form = await dialog(view, 'Revoke credential');
  await person().click(form.getByRole('button', { name: 'Revoke credential' }));
  await waitFor(() => {
    expect(sent).toEqual([
      { did: DIRECTORY.id, revision: DIRECTORY.revision, credentialId: CREDENTIAL.id },
    ]);
  });
});

test('directory edits, disable, enable and permanent removal are explicit revision-bound actions', async () => {
  let directory = DIRECTORY;
  const sent: unknown[] = [];
  const view = await open({
    workspaceDirectories: () => Promise.resolve({ data: [directory], nextCursor: null }),
    updateWorkspaceDirectory: (_id, did, input) => {
      sent.push({ did, ...input });
      directory = { ...directory, ...input };
      return Promise.resolve(directory);
    },
    deleteWorkspaceDirectory: (_id, did, input) => {
      sent.push({ deleted: did, ...input });
      return Promise.resolve();
    },
  });
  await manage(view);
  await person().click(view.getByRole('button', { name: 'Edit directory' }));
  let form = await dialog(view, 'Edit directory');
  await person().clear(form.getByRole('textbox', { name: 'Name' }));
  await person().type(form.getByRole('textbox', { name: 'Name' }), 'Workforce');
  await person().click(form.getByRole('checkbox'));
  await person().click(form.getByRole('button', { name: 'Save' }));
  await waitFor(() => {
    expect(view.queryAllByRole('dialog')).toHaveLength(0);
  });
  await person().click(view.getByRole('button', { name: 'Disable directory' }));
  form = await dialog(view, 'Disable directory');
  await person().click(form.getByRole('button', { name: 'Disable directory' }));
  await person().click(await view.findByRole('button', { name: 'Enable directory' }));
  form = await dialog(view, 'Enable directory');
  await person().click(form.getByRole('button', { name: 'Enable directory' }));
  await waitFor(() => {
    expect(view.queryAllByRole('dialog')).toHaveLength(0);
  });
  await person().click(view.getByRole('button', { name: 'Remove directory' }));
  form = await dialog(view, 'Remove Workforce?');
  await person().click(form.getByRole('button', { name: 'Remove directory' }));
  await waitFor(() => {
    expect(sent).toHaveLength(4);
  });
  expect(sent).toEqual([
    { did: DIRECTORY.id, revision: DIRECTORY.revision, name: 'Workforce', allowCreate: true },
    { did: DIRECTORY.id, revision: DIRECTORY.revision, enabled: false },
    { did: DIRECTORY.id, revision: DIRECTORY.revision, enabled: true },
    { deleted: DIRECTORY.id, revision: DIRECTORY.revision },
  ]);
});

test('a newer directory revision discards a displayed token and a workspace change closes setup state', async () => {
  let directory = DIRECTORY;
  let session = aSession();
  const api = aSignedInApi({
    me: () => Promise.resolve(session),
    workspaceDirectories: () => Promise.resolve({ data: [directory], nextCursor: null }),
    companyConnections: () =>
      Promise.resolve({
        data: [{ ...COMPANY_CONNECTION, enabled: true, ready: true }],
        nextCursor: null,
      }),
    rotateDirectoryCredential: () => {
      directory = ISSUED.directory;
      return Promise.resolve(ISSUED);
    },
  });
  const view = await renderApp(
    <ContentPortsContext.Provider
      value={{
        highlight: () => Promise.resolve(null),
        copy: () => Promise.reject(new Error('clipboard unavailable')),
      }}
    >
      <SessionGate>
        <WorkspaceScopeProvider slug="acme" notFound={<p>No workspace</p>}>
          <SettingsScreen section="directory" />
        </WorkspaceScopeProvider>
      </SessionGate>
      <Toaster dismissLabel="Close" />
    </ContentPortsContext.Provider>,
    { api },
  );
  views.push(view);
  await manage(view);
  await person().click(view.getByRole('button', { name: 'Issue or rotate credential' }));
  let form = await dialog(view, 'Issue or rotate credential');
  await person().click(form.getByRole('button', { name: 'Issue credential' }));
  form = await dialog(view, 'Save your directory token');
  await person().click(form.getByRole('button', { name: 'Copy' }));
  await view.findByText("Couldn't copy. Select the text and copy it yourself.");
  directory = { ...directory, revision: IDS.bob };
  await act(async () => {
    await view.world.client.invalidateQueries({ queryKey: ['workspace-provisioning'] });
  });
  await waitFor(() => {
    expect(view.queryAllByRole('dialog')).toHaveLength(0);
  });
  await person().click(view.getByRole('button', { name: 'Edit directory' }));
  await dialog(view, 'Edit directory');
  session = {
    ...session,
    memberships: session.memberships.map((membership) => ({
      ...membership,
      workspace: { ...membership.workspace, id: IDS.dm },
    })),
  };
  act(() => {
    view.world.client.setQueryData(keys.me, session);
  });
  await waitFor(() => {
    expect(view.queryAllByRole('dialog')).toHaveLength(0);
  });
});

test('older directory pages preserve existing rows and switching the selected directory collapses its details', async () => {
  const reads: unknown[] = [];
  const view = await open({
    workspaceDirectories: (_wid, query) => {
      reads.push(query);
      return Promise.resolve({
        data:
          query?.before === undefined
            ? [DIRECTORY]
            : [{ ...DIRECTORY, id: IDS.bob, name: 'Branch directory' }],
        nextCursor: query?.before === undefined ? IDS.bob : null,
      });
    },
  });
  await manage(view);
  await person().click(view.getByRole('button', { name: 'Manage directory' }));
  expect(view.queryByText('SCIM base URL')).toBeNull();
  await person().click(view.getByRole('button', { name: 'Show more' }));
  await view.findByText('Branch directory');
  expect(view.getByText('Office directory')).toBeDefined();
  expect(reads).toEqual([{ limit: 40 }, { limit: 40, before: IDS.bob }]);
});

test('directory drafts and credential confirmations can all be abandoned without changing authority', async () => {
  let writes = 0;
  const view = await open({
    workspaceDirectories: () =>
      Promise.resolve({ data: [{ ...DIRECTORY, credentials: [CREDENTIAL] }], nextCursor: null }),
    createWorkspaceDirectory: () => {
      writes++;
      return Promise.resolve(DIRECTORY);
    },
    updateWorkspaceDirectory: () => {
      writes++;
      return Promise.resolve(DIRECTORY);
    },
    deleteWorkspaceDirectory: () => {
      writes++;
      return Promise.resolve();
    },
    revokeDirectoryCredential: () => {
      writes++;
      return Promise.resolve(DIRECTORY);
    },
    rotateDirectoryCredential: () => {
      writes++;
      return Promise.resolve(ISSUED);
    },
  });
  await person().click(await view.findByRole('button', { name: 'Add directory' }));
  await dialog(view, 'Add directory');
  await person().keyboard('{Escape}');
  await waitFor(() => {
    expect(view.queryAllByRole('dialog')).toHaveLength(0);
  });
  await manage(view);
  for (const name of [
    'Edit directory',
    'Issue or rotate credential',
    'Disable directory',
    'Remove directory',
    'Revoke credential',
  ]) {
    await person().click(view.getByRole('button', { name }));
    const title = name === 'Remove directory' ? 'Remove Office directory?' : name;
    const form = await dialog(view, title);
    if (name === 'Edit directory' || name === 'Issue or rotate credential')
      await person().keyboard('{Escape}');
    else await person().click(form.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => {
      expect(view.queryAllByRole('dialog')).toHaveLength(0);
    });
  }
  expect(writes).toBe(0);
  await person().click(view.getByRole('button', { name: 'Issue or rotate credential' }));
  await person().click(
    (await dialog(view, 'Issue or rotate credential')).getByRole('button', {
      name: 'Issue credential',
    }),
  );
  await (await dialog(view, 'Save your directory token')).findByText(ISSUED.token);
  await person().keyboard('{Escape}');
  await waitFor(() => {
    expect(view.queryByText(ISSUED.token)).toBeNull();
  });
  expect(writes).toBe(1);
});
