/** The real settings route carries observed DNS/provider revisions through the complete setup flow. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { act, waitFor, within } from '@testing-library/react';
import type {
  CompanyIdentityDomain,
  UpdateCompanyConnectionRequest,
} from '@purlay/types/workspace-identity';
import { Outlet } from '../../app/outlet';
import type { Api } from '../../data/api';
import { ApiError } from '../../data/errors';
import { keys } from '../../data/keys';
import { installDom } from '../../testing/dom';
import { renderApp } from '../../testing/render';
import { aSession, aSignedInApi, IDS, WHEN } from '../../testing/fixtures';
import {
  COMPANY_METHODS,
  COMPANY_DOMAIN,
  COMPANY_CONNECTION,
} from '../../testing/company-identity';
import { expectNoAxeViolations } from '../../testing/axe';
import { expectFocusOn } from '../../testing/focus';
import { person } from '../../testing/user';
import { ContentPortsContext } from '../content/content-ports';
import { leave } from '../sign-in/leave';
import { Toaster } from '../../ui/toast';

installDom();
const views: Awaited<ReturnType<typeof renderApp>>[] = [];
afterEach(() => {
  for (const view of views.splice(0)) {
    view.unmount();
    view.world.client.clear();
  }
});

const open = async (
  overrides: Partial<Api> = {},
  copy: (text: string) => Promise<void> = () => {
    return Promise.resolve();
  },
): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  const view = await renderApp(
    <ContentPortsContext.Provider value={{ highlight: () => Promise.resolve(null), copy }}>
      <Outlet />
      <Toaster dismissLabel="Close" />
    </ContentPortsContext.Provider>,
    {
      path: '/w/acme/settings/company',
      api: aSignedInApi({
        authMethods: () => Promise.resolve(COMPANY_METHODS),
        companyDomains: () => Promise.resolve({ data: [COMPANY_DOMAIN], nextCursor: null }),
        companyConnections: () => Promise.resolve({ data: [COMPANY_CONNECTION], nextCursor: null }),
        ...overrides,
      }),
    },
  );
  views.push(view);
  return view;
};

test('members cannot open company administration or issue its inventory requests', async () => {
  const session = aSession();
  let reads = 0;
  const view = await open({
    me: () =>
      Promise.resolve({
        ...session,
        memberships: session.memberships.map((entry) => ({ ...entry, role: 'member' })),
      }),
    companyDomains: () => {
      reads++;
      return Promise.resolve({ data: [], nextCursor: null });
    },
  });
  await view.findByRole('heading', { name: 'Nothing here' });
  expect(reads).toBe(0);
  expect(view.queryByRole('link', { name: 'Company sign-in' })).toBeNull();
});

test('DNS proof is readable and copyable; its observed revision is verified before provider creation', async () => {
  let domains: CompanyIdentityDomain[] = [];
  const asked: unknown[] = [];
  const copied: string[] = [];
  const pending: CompanyIdentityDomain = {
    ...COMPANY_DOMAIN,
    state: 'pending',
    verifiedAt: null,
    dnsRecord: { type: 'TXT', name: '_purlay.acme.example', value: 'purlay=public-proof-value' },
  };
  const view = await open(
    {
      companyDomains: () => Promise.resolve({ data: domains, nextCursor: null }),
      companyConnections: () => Promise.resolve({ data: [], nextCursor: null }),
      createCompanyDomain: (workspace, input) => {
        asked.push({ workspace, input });
        domains = [pending];
        return Promise.resolve(pending);
      },
      verifyCompanyDomain: (workspace, id, revision) => {
        asked.push({ workspace, id, revision });
        domains = [COMPANY_DOMAIN];
        return Promise.resolve(COMPANY_DOMAIN);
      },
    },
    (value) => {
      copied.push(value);
      return Promise.resolve();
    },
  );
  const add = await view.findByRole('button', { name: 'Add provider' });
  expect((add as HTMLButtonElement).disabled).toBe(true);
  await person().type(view.getByRole('textbox', { name: 'Domain' }), 'acme.example');
  await person().click(view.getByRole('button', { name: 'Add domain' }));
  await view.findByText('_purlay.acme.example');
  await person().click(view.getByRole('button', { name: 'Copy TXT record value' }));
  expect(copied).toEqual(['purlay=public-proof-value']);
  await person().click(view.getByRole('button', { name: 'Check DNS' }));
  await view.findByText('Verified');
  expect(asked).toEqual([
    { workspace: IDS.workspace, input: { domain: 'acme.example' } },
    { workspace: IDS.workspace, id: COMPANY_DOMAIN.id, revision: COMPANY_DOMAIN.revision },
  ]);
  expect((add as HTMLButtonElement).disabled).toBe(false);
  await expectNoAxeViolations(view.getByRole('main'));
});

test('provider test requires a real redirect and only refreshed server proof enables sign-in', async () => {
  let connection = COMPANY_CONNECTION;
  const asked: unknown[] = [];
  const navigation = spyOn(leave, 'to').mockImplementation(() => undefined);
  try {
    const view = await open({
      companyConnections: () => Promise.resolve({ data: [connection], nextCursor: null }),
      startCompanyIdentity: (input) => {
        asked.push(input);
        return Promise.resolve({ url: 'https://identity.example/authorize' });
      },
      setCompanyConnectionEnabled: (workspace, id, revision, enabled) => {
        asked.push({ workspace, id, revision, enabled });
        connection = { ...connection, enabled };
        return Promise.resolve(connection);
      },
    });
    const enable = await view.findByRole('button', { name: 'Enable sign-in' });
    expect((enable as HTMLButtonElement).disabled).toBe(true);
    await person().click(view.getByRole('button', { name: 'Test sign-in' }));
    expect(navigation.mock.calls).toEqual([['https://identity.example/authorize']]);
    expect((enable as HTMLButtonElement).disabled).toBe(true);
    connection = { ...connection, ready: true, testedAt: WHEN, revision: IDS.incidents };
    await person().click(view.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => {
      expect((enable as HTMLButtonElement).disabled).toBe(false);
    });
    await person().click(enable);
    await view.findByText('Sign-in enabled');
    expect(asked).toEqual([
      {
        workspaceId: IDS.workspace,
        connectionId: COMPANY_CONNECTION.id,
        revision: COMPANY_CONNECTION.revision,
        intent: 'test',
      },
      {
        workspace: IDS.workspace,
        id: COMPANY_CONNECTION.id,
        revision: IDS.incidents,
        enabled: true,
      },
    ]);
  } finally {
    navigation.mockRestore();
  }
});

test('editing does not write unchanged credentials; changing a name preserves the write-only secret', async () => {
  let connection = COMPANY_CONNECTION;
  const edits: UpdateCompanyConnectionRequest[] = [];
  const view = await open({
    companyConnections: () => Promise.resolve({ data: [connection], nextCursor: null }),
    updateCompanyConnection: (_workspace, _id, input) => {
      edits.push(input);
      connection = { ...connection, name: input.name ?? connection.name, revision: IDS.incidents };
      return Promise.resolve(connection);
    },
  });
  await person().click(await view.findByRole('button', { name: 'Edit provider' }));
  const name = view.getByRole('textbox', { name: 'Provider name' });
  expectFocusOn(name);
  expect((view.getByLabelText('Client secret') as HTMLInputElement).value).toBe('');
  expect(
    (view.getByRole('button', { name: 'Save connection' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  await person().clear(name);
  await person().type(name, 'Company account');
  await person().click(view.getByRole('button', { name: 'Save connection' }));
  await view.findByRole('heading', { name: 'Company account' });
  expect(edits).toEqual([
    {
      name: 'Company account',
      issuer: COMPANY_CONNECTION.issuer,
      domainId: COMPANY_DOMAIN.id,
      clientId: COMPANY_CONNECTION.clientId,
      revision: COMPANY_CONNECTION.revision,
    },
  ]);
});

test('a refreshed revision fences a dirty edit; explicit reload discards its secret and Cancel restores focus', async () => {
  const view = await open();
  const trigger = await view.findByRole('button', { name: 'Edit provider' });
  await person().click(trigger);
  await person().type(view.getByLabelText('Client secret'), 'unsaved-secret');
  await act(() => {
    view.world.client.setQueryData(keys.companyConnections(IDS.workspace, IDS.me), {
      data: [{ ...COMPANY_CONNECTION, revision: IDS.incidents, name: 'Other administrator' }],
    });
    return Promise.resolve();
  });
  await view.findByRole('alert');
  expect(
    (view.getByRole('button', { name: 'Save connection' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  await person().click(view.getByRole('button', { name: 'Reload connection' }));
  expect((view.getByLabelText('Client secret') as HTMLInputElement).value).toBe('');
  expect((view.getByRole('textbox', { name: 'Provider name' }) as HTMLInputElement).value).toBe(
    'Other administrator',
  );
  await person().click(view.getByRole('button', { name: 'Cancel' }));
  expectFocusOn(trigger);
});

test('inventory errors and clipboard refusals have recovery without enabling empty provider creation', async () => {
  let fails = true;
  const view = await open(
    {
      companyDomains: () => {
        if (fails) return Promise.reject(new ApiError(0, 'NETWORK', 'offline'));
        return Promise.resolve({ data: [COMPANY_DOMAIN], nextCursor: null });
      },
    },
    () => {
      return Promise.reject(new Error('clipboard refused'));
    },
  );
  await view.findByRole('alert');
  expect((view.getByRole('button', { name: 'Add provider' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fails = false;
  await person().click(
    within(view.getByRole('region', { name: 'Verified domains' })).getByRole('button', {
      name: 'Retry',
    }),
  );
  await view.findByText('Verified');
  await person().click(view.getByRole('button', { name: 'Copy Authorized redirect URI' }));
  await view.findByText("Couldn't copy. Select the text and copy it yourself.");
});

test('a refused domain removal reports inside its focused dialog and preserves the domain', async () => {
  const view = await open({
    revokeCompanyDomain: () => Promise.reject(new ApiError(0, 'NETWORK', 'offline')),
  });
  await person().click(await view.findByRole('button', { name: 'Revoke domain' }));
  const dialog = view.getByRole('dialog');
  await person().click(within(dialog).getByRole('button', { name: 'Remove' }));
  expect(await within(dialog).findByRole('alert')).toBeDefined();
  await person().keyboard('{Escape}');
  expect(view.getByRole('heading', { name: 'acme.example' })).toBeDefined();
});

test('a refused save is visible within its editor and preserves the typed credential for retry', async () => {
  const view = await open({
    updateCompanyConnection: () => Promise.reject(new ApiError(0, 'NETWORK', 'offline')),
  });
  await person().click(await view.findByRole('button', { name: 'Edit provider' }));
  const editor = within(view.getByRole('region', { name: 'Edit provider' }));
  await person().type(editor.getByLabelText('Client secret'), 'unsaved-secret');
  await person().click(editor.getByRole('button', { name: 'Save connection' }));
  expect(await editor.findByRole('alert')).toBeDefined();
  expect(editor.getByLabelText<HTMLInputElement>('Client secret').value).toBe('unsaved-secret');
});

test('a new provider uses the selected verified domain and clears its write-only form after creation', async () => {
  const second = { ...COMPANY_DOMAIN, id: IDS.incidents, domain: 'branch.example' };
  let connections = [COMPANY_CONNECTION];
  const writes: unknown[] = [];
  const view = await open({
    companyDomains: () => Promise.resolve({ data: [COMPANY_DOMAIN, second], nextCursor: null }),
    companyConnections: () => Promise.resolve({ data: connections, nextCursor: null }),
    createCompanyConnection: (workspace, input) => {
      writes.push({ workspace, input });
      const made = {
        ...COMPANY_CONNECTION,
        id: IDS.api,
        name: input.name,
        domainId: input.domainId,
        issuer: input.issuer,
        clientId: input.clientId,
      };
      connections = [...connections, made];
      return Promise.resolve(made);
    },
  });
  await person().click(await view.findByRole('button', { name: 'Add provider' }));
  const editor = within(view.getByRole('region', { name: 'Add provider' }));
  await person().type(editor.getByRole('textbox', { name: 'Provider name' }), 'Branch account');
  await person().selectOptions(editor.getByRole('combobox'), second.id);
  await person().type(
    editor.getByRole('textbox', { name: 'Issuer URL' }),
    'https://branch.example',
  );
  await person().type(editor.getByRole('textbox', { name: 'Client ID' }), 'branch-client');
  await person().type(editor.getByLabelText('Client secret'), 'one-time-secret');
  await person().click(editor.getByRole('button', { name: 'Save connection' }));
  await view.findByRole('heading', { name: 'Branch account' });
  expect(writes).toEqual([
    {
      workspace: IDS.workspace,
      input: {
        name: 'Branch account',
        domainId: second.id,
        issuer: 'https://branch.example',
        clientId: 'branch-client',
        clientSecret: 'one-time-secret',
      },
    },
  ]);
  expect(view.queryByLabelText('Client secret')).toBeNull();
});

test('renewing expired proof and confirming removal use the currently observed domain revision', async () => {
  let domains: CompanyIdentityDomain[] = [
    { ...COMPANY_DOMAIN, state: 'expired', verifiedAt: null },
  ];
  const writes: unknown[] = [];
  const view = await open({
    companyDomains: () => Promise.resolve({ data: domains, nextCursor: null }),
    renewCompanyDomain: (workspace, id, revision) => {
      writes.push({ workspace, id, revision });
      const renewed: CompanyIdentityDomain = {
        ...COMPANY_DOMAIN,
        revision: IDS.incidents,
        state: 'pending',
        verifiedAt: null,
        dnsRecord: { type: 'TXT', name: '_purlay.acme.example', value: 'replacement-proof' },
      };
      domains = [renewed];
      return Promise.resolve(renewed);
    },
    revokeCompanyDomain: (workspace, id, revision) => {
      writes.push({ workspace, id, revision });
      domains = [];
      return Promise.resolve();
    },
  });
  expect(
    ((await view.findByRole('button', { name: 'Check DNS' })) as HTMLButtonElement).disabled,
  ).toBe(true);
  await person().click(view.getByRole('button', { name: 'Renew proof' }));
  await view.findByText('replacement-proof');
  await person().click(view.getByRole('button', { name: 'Revoke domain' }));
  let dialog = view.getByRole('dialog');
  await person().click(within(dialog).getByText('Cancel', { selector: 'button' }));
  expect(writes).toHaveLength(1);
  await person().click(view.getByRole('button', { name: 'Revoke domain' }));
  dialog = view.getByRole('dialog');
  await person().click(within(dialog).getByRole('button', { name: 'Remove' }));
  await waitFor(() => {
    expect(view.queryByRole('heading', { name: 'acme.example' })).toBeNull();
  });
  expect(writes).toEqual([
    { workspace: IDS.workspace, id: COMPANY_DOMAIN.id, revision: COMPANY_DOMAIN.revision },
    { workspace: IDS.workspace, id: COMPANY_DOMAIN.id, revision: IDS.incidents },
  ]);
});

test('removing a provider preserves the verified domain and requires confirmation', async () => {
  let present = true;
  const writes: unknown[] = [];
  const view = await open({
    companyConnections: () =>
      Promise.resolve({ data: present ? [COMPANY_CONNECTION] : [], nextCursor: null }),
    deleteCompanyConnection: (workspace, id, revision) => {
      writes.push({ workspace, id, revision });
      present = false;
      return Promise.resolve();
    },
  });
  await person().click(await view.findByRole('button', { name: 'Remove provider' }));
  expect(writes).toEqual([]);
  await person().click(within(view.getByRole('dialog')).getByRole('button', { name: 'Remove' }));
  await waitFor(() => {
    expect(view.queryByRole('heading', { name: COMPANY_CONNECTION.name })).toBeNull();
  });
  expect(view.getByRole('heading', { name: COMPANY_DOMAIN.domain })).toBeDefined();
  expect(writes).toEqual([
    { workspace: IDS.workspace, id: COMPANY_CONNECTION.id, revision: COMPANY_CONNECTION.revision },
  ]);
});

test('server capability errors can recover, and a server without company sign-in makes no catalogue request', async () => {
  let failed = true;
  let reads = 0;
  const unavailable = { ...COMPANY_METHODS };
  delete unavailable.company;
  const view = await open({
    authMethods: () =>
      failed
        ? Promise.reject(new ApiError(0, 'MALFORMED', 'invalid capability response'))
        : Promise.resolve(unavailable),
    companyDomains: () => {
      reads++;
      return Promise.resolve({ data: [], nextCursor: null });
    },
  });
  await view.findByRole('alert');
  failed = false;
  await person().click(view.getByRole('button', { name: 'Retry' }));
  await view.findByText('Company sign-in is not available on this server.');
  expect(reads).toBe(0);
});
