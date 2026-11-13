/** Product flows through real routes/providers, with only the HTTP/native-auth boundary replaced. */
import { afterEach, expect, jest, test } from 'bun:test';
import { act, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Outlet } from '../../../app/outlet';
import type { Api } from '../../../data/api';
import { ApiError, LibraryFailure } from '../../../data/errors';
import { workspaceAccessRequired, workspaceAccessRequiredKey } from '../../../data/access-change';
import { keys } from '../../../data/keys';
import { installDom } from '../../../testing/dom';
import { renderApp } from '../../../testing/render';
import { aChannel, aMessage, aSession, aSignedInApi, IDS } from '../../../testing/fixtures';
import { COMPANY_CONNECTION } from '../../../testing/company-identity';
import {
  SECURITY_CHALLENGE,
  SECURITY_CODES,
  SECURITY_ENROLLMENT,
  SECURITY_ENTRY,
  SECURITY_FACTOR,
  SECURITY_MFA,
  SECURITY_POLICY,
  SECURITY_PREVIEW,
  SECURITY_STATUS,
  SECURITY_TEST,
} from '../../../testing/workspace-security';
import { expectNoAxeViolations } from '../../../testing/axe';
import { person } from '../../../testing/user';
import { ContentPortsContext } from '../../content/content-ports';
import { Toaster } from '../../../ui/toast';
import { systemClock } from '../../../system-clock';

installDom();
type View = Awaited<ReturnType<typeof renderApp>>;
const views: View[] = [];
afterEach(() => {
  for (const view of views.splice(0)) {
    view.unmount();
    view.world.client.clear();
  }
});
const open = async (
  overrides: Partial<Api> = {},
  options: {
    readonly path?: string;
    readonly locale?: 'en' | 'tr';
    readonly copy?: (value: string) => Promise<void>;
  } = {},
): Promise<View> => {
  const view = await renderApp(
    <ContentPortsContext.Provider
      value={{
        highlight: () => Promise.resolve(null),
        copy: options.copy ?? ((): Promise<void> => Promise.resolve()),
      }}
    >
      <Outlet />
      <Toaster dismissLabel="Close" />
    </ContentPortsContext.Provider>,
    {
      path: options.path ?? '/w/acme/settings/security',
      locale: options.locale ?? 'en',
      api: aSignedInApi({
        workspacePolicy: () => Promise.resolve(SECURITY_POLICY),
        companyConnections: () =>
          Promise.resolve({
            data: [{ ...COMPANY_CONNECTION, ready: true, enabled: true }],
            nextCursor: null,
          }),
        workspaceSecurityEntry: () => Promise.resolve(SECURITY_ENTRY),
        myWorkspaceMfa: () => Promise.resolve(SECURITY_MFA),
        ...overrides,
      }),
    },
  );
  views.push(view);
  return view;
};
const inputCode = async (view: View, value = '123456'): Promise<void> => {
  await person().type(await view.findByRole('textbox', { name: 'Authenticator code' }), value);
  await person().click(view.getByRole('button', { name: 'Verify code' }));
};

test('standalone remediation resolves own metadata without mounting chat, members or a socket', async () => {
  let content = 0;
  let lookup = 0;
  const view = await open(
    {
      workspaceSecurityEntry: () => {
        lookup++;
        return Promise.resolve({
          ...SECURITY_ENTRY,
          status: { ...SECURITY_STATUS, state: 'mfa_enrollment_required' },
        });
      },
      channels: () => {
        content++;
        return Promise.resolve([]);
      },
      members: () => {
        content++;
        return Promise.resolve([]);
      },
    },
    { path: '/workspace-access?workspace=acme' },
  );
  await view.findByRole('button', { name: 'Set up authenticator' });
  expect(lookup).toBe(1);
  expect(content).toBe(0);
  expect(view.world.sockets.sockets).toHaveLength(0);
  expect(view.queryByRole('navigation', { name: 'Settings' })).toBeNull();
  await expectNoAxeViolations(view.getByRole('main'));
});

test('own authenticator setup shows a real QR, confirms the actual code and keeps recovery secrets out of query data', async () => {
  let mine = SECURITY_MFA;
  const seen: unknown[] = [];
  const copied: string[] = [];
  const view = await open(
    {
      myWorkspaceMfa: () => Promise.resolve(mine),
      startWorkspaceMfaEnrollment: (_id, input) => {
        seen.push(input);
        return Promise.resolve(SECURITY_ENROLLMENT);
      },
      verifyWorkspaceMfa: (_id, input) => {
        seen.push(input);
        mine = { ...mine, factor: SECURITY_FACTOR, recoveryCodesRemaining: 10 };
        return Promise.resolve({
          status: SECURITY_STATUS,
          factor: SECURITY_FACTOR,
          recoveryCodes: SECURITY_CODES,
        });
      },
    },
    {
      path: '/w/acme/settings/workspace-mfa',
      copy: (text) => {
        copied.push(text);
        return Promise.resolve();
      },
    },
  );
  await person().click(await view.findByRole('button', { name: 'Set up authenticator' }));
  await view.findByRole('img', { name: 'Workspace authenticator QR code' });
  expect(view.getByText('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP')).toBeDefined();
  await inputCode(view);
  await view.findByRole('heading', { name: 'Keep your recovery codes' });
  expect(seen).toEqual([
    { policyRevision: IDS.alice, factorRevision: null },
    { challengeId: SECURITY_CHALLENGE.challengeId, code: '123456' },
  ]);
  const section = view.getByRole('region', { name: 'Keep your recovery codes' });
  await person().click(within(section).getByRole('button', { name: 'Copy' }));
  expect(copied).toEqual([SECURITY_CODES.backupCodes.join('\n')]);
  const cache = JSON.stringify(
    view.world.client
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data),
  );
  expect(cache).not.toContain('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP');
  expect(cache).not.toContain(SECURITY_CHALLENGE.challengeId);
  expect(cache).not.toContain(SECURITY_CODES.backupCodes[0] ?? '');
  await expectNoAxeViolations(view.getByRole('main'));
  await person().click(view.getByRole('button', { name: 'I saved these codes' }));
  expect(view.queryByText(SECURITY_CODES.backupCodes.join('\n'))).toBeNull();
});

test('invalid local codes never make a verification request', async () => {
  let requests = 0;
  const view = await open(
    {
      startWorkspaceMfaEnrollment: () => Promise.resolve(SECURITY_ENROLLMENT),
      verifyWorkspaceMfa: () => {
        requests++;
        return Promise.resolve({ status: SECURITY_STATUS, factor: SECURITY_FACTOR });
      },
    },
    { path: '/w/acme/settings/workspace-mfa' },
  );
  await person().click(await view.findByRole('button', { name: 'Set up authenticator' }));
  await inputCode(view, '123');
  await view.findByText('Enter the six digits from your authenticator app.');
  expect(requests).toBe(0);
});

test('lost authenticator uses a purpose-bound workspace recovery challenge, never a global credential endpoint', async () => {
  const seen: unknown[] = [];
  const view = await open(
    {
      myWorkspaceMfa: () =>
        Promise.resolve({ ...SECURITY_MFA, factor: SECURITY_FACTOR, recoveryCodesRemaining: 10 }),
      startWorkspaceMfaChallenge: (_id, input) => {
        seen.push(input);
        return Promise.resolve(SECURITY_CHALLENGE);
      },
      recoverWorkspaceMfa: (_id, input) => {
        seen.push(input);
        return Promise.resolve({ status: SECURITY_STATUS, factor: SECURITY_FACTOR });
      },
    },
    { path: '/w/acme/settings/workspace-mfa' },
  );
  await person().click(await view.findByRole('button', { name: 'Verify access' }));
  await person().click(await view.findByRole('button', { name: 'Use a recovery code instead' }));
  await person().type(
    view.getByRole('textbox', { name: 'Recovery code' }),
    SECURITY_CODES.backupCodes[0] ?? '',
  );
  await person().click(view.getByRole('button', { name: 'Verify code' }));
  await view.findByText('Verification completed.');
  expect(seen).toEqual([
    { policyRevision: IDS.alice, purpose: 'step_up', factorScope: 'workspace' },
    { challengeId: SECURITY_CHALLENGE.challengeId, code: SECURITY_CODES.backupCodes[0] },
  ]);
});

test('replacement authenticates the old factor before showing a pending new key', async () => {
  const seen: unknown[] = [];
  const view = await open(
    {
      myWorkspaceMfa: () => Promise.resolve({ ...SECURITY_MFA, factor: SECURITY_FACTOR }),
      startWorkspaceMfaChallenge: (_id, input) => {
        seen.push(input);
        return Promise.resolve({ ...SECURITY_CHALLENGE, purpose: 'rotate' });
      },
      verifyWorkspaceMfa: () =>
        Promise.resolve({ status: SECURITY_STATUS, factor: SECURITY_FACTOR }),
      startWorkspaceMfaEnrollment: (_id, input) => {
        seen.push(input);
        return Promise.resolve(SECURITY_ENROLLMENT);
      },
    },
    { path: '/w/acme/settings/workspace-mfa' },
  );
  await person().click(await view.findByRole('button', { name: 'Replace authenticator' }));
  expect(view.queryByRole('img')).toBeNull();
  await inputCode(view);
  await view.findByRole('img', { name: 'Workspace authenticator QR code' });
  expect(seen).toEqual([
    { policyRevision: IDS.alice, purpose: 'rotate', factorScope: 'workspace' },
    {
      policyRevision: IDS.alice,
      factorRevision: SECURITY_FACTOR.revision,
      authorizationChallengeId: SECURITY_CHALLENGE.challengeId,
    },
  ]);
  expect(
    view.getByText('Your current authenticator keeps working until you confirm the replacement.'),
  ).toBeDefined();
});

test('company sessions cannot invoke an account authenticator but can verify their own workspace factor', async () => {
  const session = aSession();
  const view = await open(
    {
      me: () => Promise.resolve({ ...session, companyWorkspaceId: IDS.workspace }),
      myWorkspaceMfa: () =>
        Promise.resolve({ ...SECURITY_MFA, factor: SECURITY_FACTOR, globalMfaAvailable: true }),
    },
    { path: '/w/acme/settings/workspace-mfa' },
  );
  await view.findByRole('button', { name: 'Verify access' });
  expect(view.queryByRole('button', { name: 'Verify with account authenticator' })).toBeNull();
});

test('independent global MFA uses native verification then refreshes workspace status', async () => {
  let verifies = 0;
  let reads = 0;
  const view = await open(
    {
      myWorkspaceMfa: () => {
        reads++;
        return Promise.resolve({ ...SECURITY_MFA, globalMfaAvailable: true });
      },
      verifySignInCode: (input) => {
        expect(input).toEqual({ code: '123456', kind: 'app' });
        verifies++;
        return Promise.resolve();
      },
    },
    { path: '/w/acme/settings/workspace-mfa' },
  );
  await person().click(
    await view.findByRole('button', { name: 'Verify with account authenticator' }),
  );
  await inputCode(view);
  await view.findByText('Verification completed.');
  expect(verifies).toBe(1);
  expect(reads).toBeGreaterThanOrEqual(2);
});

test('a member has own MFA settings but cannot load administrator policy inventory', async () => {
  const session = aSession();
  let policyReads = 0;
  const view = await open({
    me: () =>
      Promise.resolve({
        ...session,
        memberships: session.memberships.map((item) => ({ ...item, role: 'member' })),
      }),
    workspacePolicy: () => {
      policyReads++;
      return Promise.resolve(SECURITY_POLICY);
    },
  });
  await view.findByRole('heading', { name: 'Nothing here' });
  expect(policyReads).toBe(0);
  expect(view.getByRole('link', { name: 'Your workspace authenticator' })).toBeDefined();
  expect(view.queryByRole('link', { name: 'Workspace security' })).toBeNull();
});

test('policy enforcement requires impact, a real passed test and explicit acknowledgement', async () => {
  const seen: unknown[] = [];
  let policy = SECURITY_POLICY;
  const view = await open({
    workspacePolicy: () => Promise.resolve(policy),
    previewWorkspacePolicy: (_id, input) => {
      seen.push({ preview: input });
      return Promise.resolve(SECURITY_PREVIEW);
    },
    testWorkspacePolicy: (_id, input) => {
      seen.push({ test: input });
      return Promise.resolve(SECURITY_TEST);
    },
    updateWorkspacePolicy: (_id, input) => {
      seen.push({ save: input });
      policy = { ...policy, ...input.policy, revision: IDS.bob };
      return Promise.resolve(policy);
    },
  });
  const mode = await view.findByRole('combobox', { name: 'Apply requirements' });
  fireEvent.change(mode, { target: { value: 'enforced' } });
  expect(view.queryByRole('button', { name: 'Save tested requirements' })).toBeNull();
  await person().click(view.getByRole('button', { name: 'Preview impact' }));
  await view.findByText('Affected members: 1; guests: 1; sessions: 3.');
  await person().click(view.getByRole('button', { name: 'Test these requirements' }));
  await view.findByText('Your access passed this test. These requirements are ready to save.');
  const save = view.getByRole('button', { name: 'Save tested requirements' }) as HTMLButtonElement;
  expect(save.disabled).toBe(true);
  await person().click(
    view.getByRole('checkbox', {
      name: 'I understand that affected people must verify before returning to this workspace.',
    }),
  );
  expect(save.disabled).toBe(false);
  await expectNoAxeViolations(view.getByRole('main'));
  await person().click(save);
  await waitFor(() => {
    expect(seen).toHaveLength(3);
  });
  const expected = {
    revision: IDS.alice,
    policy: {
      mode: 'enforced',
      signIn: 'any',
      allowedConnectionIds: [],
      requireMfa: false,
      idleMinutes: null,
      maxAgeHours: null,
      mfaMaxAgeMinutes: null,
    },
  };
  expect(seen).toEqual([
    { preview: expected },
    { test: expected },
    { save: { ...expected, testId: SECURITY_TEST.testId, testToken: SECURITY_TEST.testToken } },
  ]);
});

test('changing requirements invalidates the earlier preview and test instead of reusing a receipt', async () => {
  const view = await open({
    previewWorkspacePolicy: () => Promise.resolve(SECURITY_PREVIEW),
    testWorkspacePolicy: () => Promise.resolve(SECURITY_TEST),
  });
  await person().click(await view.findByRole('button', { name: 'Preview impact' }));
  await person().click(await view.findByRole('button', { name: 'Test these requirements' }));
  await view.findByRole('button', { name: 'Save tested requirements' });
  await person().click(view.getByRole('checkbox', { name: 'Require an authenticator' }));
  expect(view.queryByRole('button', { name: 'Save tested requirements' })).toBeNull();
  expect(
    view.queryByText('Your access passed this test. These requirements are ready to save.'),
  ).toBeNull();
});

test('an owner without a recoverable path cannot enforce a passed policy', async () => {
  const view = await open({
    previewWorkspacePolicy: () =>
      Promise.resolve({ ...SECURITY_PREVIEW, ownerRecoveryReady: false }),
    testWorkspacePolicy: () => Promise.resolve(SECURITY_TEST),
  });
  fireEvent.change(await view.findByRole('combobox', { name: 'Apply requirements' }), {
    target: { value: 'enforced' },
  });
  await person().click(view.getByRole('button', { name: 'Preview impact' }));
  await view.findByText(/Enforcement needs an owner/);
  await person().click(view.getByRole('button', { name: 'Test these requirements' }));
  const save = await view.findByRole('button', { name: 'Save tested requirements' });
  expect((save as HTMLButtonElement).disabled).toBe(true);
});

test('only tested enabled company providers are selectable and guests remain in the stated scope', async () => {
  const view = await open({
    companyConnections: () => Promise.resolve({ data: [COMPANY_CONNECTION], nextCursor: null }),
  });
  fireEvent.change(await view.findByRole('combobox', { name: 'Sign-in method for members' }), {
    target: { value: 'company' },
  });
  const provider = await view.findByRole('checkbox', { name: /Office/ });
  expect((provider as HTMLInputElement).disabled).toBe(true);
  await person().click(view.getByRole('button', { name: 'Preview impact' }));
  await view.findByText('Check the selected providers and time limits before continuing.');
  expect(view.getByText(/Guests keep independent sign-in/)).toBeDefined();
});

test('standalone expired access asks for primary sign-in, without offering a code as a lifetime extension', async () => {
  const view = await open(
    {
      workspaceSecurityEntry: () =>
        Promise.resolve({ ...SECURITY_ENTRY, status: { ...SECURITY_STATUS, state: 'expired' } }),
    },
    { path: '/workspace-access?workspace=acme' },
  );
  const signin = await view.findByRole('link', { name: 'Sign in again' });
  expect(signin.getAttribute('href')).toBe('/sign-in?workspace=acme&independent=1');
  expect(view.queryByRole('button', { name: 'Verify access' })).toBeNull();
});

test('exact workspace denial clears its content and routes only that workspace without signing the native account out', async () => {
  const view = await open({}, { path: '/w/acme/settings/workspace-mfa' });
  await view.findByRole('button', { name: 'Set up authenticator' });
  const otherChannels = [aChannel(IDS.dm, 'elsewhere', { workspaceId: IDS.browse })];
  const otherMessages = {
    pages: [{ data: [aMessage(2, { channelId: IDS.dm })], nextCursor: null }],
    pageParams: [undefined],
  };
  view.world.client.setQueryData(keys.channels(IDS.workspace), [aChannel(IDS.api, 'private-a')]);
  view.world.client.setQueryData(keys.messages(IDS.api), {
    pages: [{ data: [aMessage(1)], nextCursor: null }],
    pageParams: [undefined],
  });
  view.world.client.setQueryData(keys.channels(IDS.browse), otherChannels);
  view.world.client.setQueryData(keys.messages(IDS.dm), otherMessages);
  const otherIssues = [{ privateText: 'Workspace B issue' }];
  view.world.client.setQueryData(keys.issues(IDS.workspace), [
    { privateText: 'Denied workspace A issue' },
  ]);
  view.world.client.setQueryData(keys.issues(IDS.browse), otherIssues);
  act(() => {
    workspaceAccessRequired(view.world.client, IDS.workspace);
  });
  await view.findByRole('heading', { name: 'Verify workspace access' });
  expect(view.world.history.read().pathname).toBe('/workspace-access');
  expect(view.world.client.getQueryData(keys.me)).toBeDefined();
  expect(view.world.client.getQueryData(keys.channels(IDS.workspace))).toBeUndefined();
  expect(view.world.client.getQueryData(keys.issues(IDS.workspace))).toBeUndefined();
  expect(view.world.client.getQueryData(keys.issues(IDS.browse))).toEqual(otherIssues);
  expect(view.world.client.getQueryData(keys.messages(IDS.api))).toBeUndefined();
  expect(view.world.client.getQueryData(keys.channels(IDS.browse))).toEqual(otherChannels);
  expect(view.world.client.getQueryData(keys.messages(IDS.dm))).toEqual(otherMessages);
  expect(view.world.client.getQueryData(workspaceAccessRequiredKey(IDS.workspace, IDS.me))).toBe(
    true,
  );
});

test('stale and offline refusals remain visible with a retry instead of inventing a successful change', async () => {
  let tries = 0;
  const view = await open(
    {
      startWorkspaceMfaEnrollment: () => {
        tries++;
        return Promise.reject(new ApiError(0, 'NETWORK', 'offline'));
      },
    },
    { path: '/w/acme/settings/workspace-mfa' },
  );
  await person().click(await view.findByRole('button', { name: 'Set up authenticator' }));
  await view.findByRole('alert');
  expect(view.queryByRole('img')).toBeNull();
  expect(view.queryByText('Verification completed.')).toBeNull();
  expect(tries).toBe(1);
  await person().click(view.getByRole('button', { name: 'Set up authenticator' }));
  await waitFor(() => {
    expect(tries).toBe(2);
  });
});

test('Turkish security copy renders for employees and owner recovery remains one opaque value', async () => {
  const view = await open({}, { path: '/w/acme/settings/workspace-mfa', locale: 'tr' });
  await view.findByRole('heading', { level: 1, name: 'Çalışma alanı doğrulayıcınız' });
  expect(view.getByRole('button', { name: 'Doğrulayıcı kur' })).toBeDefined();
});

test('policy MFA resumes the same real test ticket after consuming its purpose-bound challenge', async () => {
  const seen: unknown[] = [];
  let tests = 0;
  const view = await open({
    previewWorkspacePolicy: () => Promise.resolve(SECURITY_PREVIEW),
    testWorkspacePolicy: (_id, input) => {
      seen.push(input);
      tests++;
      return Promise.resolve(
        tests === 1
          ? { ...SECURITY_TEST, status: { ...SECURITY_STATUS, state: 'mfa_required' } }
          : SECURITY_TEST,
      );
    },
    myWorkspaceMfa: () => Promise.resolve({ ...SECURITY_MFA, factor: SECURITY_FACTOR }),
    startWorkspaceMfaChallenge: (_id, input) => {
      seen.push(input);
      return Promise.resolve({ ...SECURITY_CHALLENGE, purpose: 'policy_test' });
    },
    verifyWorkspaceMfa: () => Promise.resolve({ status: SECURITY_STATUS, factor: SECURITY_FACTOR }),
  });
  await person().click(await view.findByRole('button', { name: 'Preview impact' }));
  await person().click(await view.findByRole('button', { name: 'Test these requirements' }));
  await person().click(await view.findByRole('button', { name: 'Verify access' }));
  await inputCode(view);
  await view.findByRole('button', { name: 'Save tested requirements' });
  expect(seen[1]).toEqual({
    policyRevision: IDS.alice,
    purpose: 'policy_test',
    factorScope: 'workspace',
    testId: SECURITY_TEST.testId,
  });
  expect(seen[2]).toMatchObject({
    testId: SECURITY_TEST.testId,
    testToken: SECURITY_TEST.testToken,
  });
  expect(tests).toBe(2);
});

test('owner recovery is one opaque copyable value, shown once and absent from cached GET data', async () => {
  const copied: string[] = [];
  const value = `${IDS.bob}.${'r'.repeat(43)}`;
  const seen: unknown[] = [];
  const view = await open(
    {
      createWorkspacePolicyRecovery: (_id, input) => {
        seen.push(input);
        return Promise.resolve({ revision: IDS.bob, recoveryCode: 'r'.repeat(43) });
      },
    },
    {
      copy: (text) => {
        copied.push(text);
        return Promise.resolve();
      },
    },
  );
  await person().click(await view.findByRole('button', { name: 'Create owner recovery code' }));
  await view.findByText(value);
  const card = view.getByRole('region', { name: 'Owner recovery' });
  await person().click(within(card).getByRole('button', { name: 'Copy' }));
  expect(copied).toEqual([value]);
  expect(seen).toEqual([{ policyRevision: IDS.alice }]);
  expect(
    JSON.stringify(
      view.world.client
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data),
    ),
  ).not.toContain('r'.repeat(43));
  await person().click(view.getByRole('button', { name: 'I saved the recovery code' }));
  expect(view.queryByText(value)).toBeNull();
});

test('company-only owner regeneration retains a purpose-bound ticket across explicit independent reauthentication, never disabling policy', async () => {
  const session = aSession();
  let independent = false;
  const seen: unknown[] = [];
  let changed = 0;
  const current = {
    ...SECURITY_POLICY,
    mode: 'enforced' as const,
    signIn: 'company' as const,
    allowedConnectionIds: [COMPANY_CONNECTION.id],
  };
  const view = await open({
    me: () =>
      Promise.resolve(independent ? session : { ...session, companyWorkspaceId: IDS.workspace }),
    workspacePolicy: () => Promise.resolve(current),
    testWorkspacePolicy: (_id, input) => {
      seen.push(input);
      return Promise.resolve(SECURITY_TEST);
    },
    createWorkspacePolicyRecovery: (_id, input) => {
      seen.push(input);
      return Promise.resolve({ revision: IDS.bob, recoveryCode: 'r'.repeat(43) });
    },
    updateWorkspacePolicy: () => {
      changed++;
      return Promise.resolve(current);
    },
  });
  await person().click(await view.findByRole('button', { name: 'Prepare a new recovery code' }));
  const link = await view.findByRole('link', { name: 'Sign in in a new tab' });
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('href')).not.toContain(SECURITY_TEST.testToken);
  independent = true;
  await person().click(view.getByRole('button', { name: 'I signed in — create recovery code' }));
  await view.findByText(`${IDS.bob}.${'r'.repeat(43)}`);
  expect(seen[0]).toMatchObject({
    purpose: 'recovery_setup',
    revision: IDS.alice,
    policy: { mode: 'enforced', signIn: 'company' },
  });
  expect(seen[1]).toEqual({
    policyRevision: IDS.alice,
    testId: SECURITY_TEST.testId,
    testToken: SECURITY_TEST.testToken,
  });
  expect(changed).toBe(0);
});

test('expired policy tickets never enable enforcement even if their old status said allowed', async () => {
  const view = await open({
    previewWorkspacePolicy: () => Promise.resolve(SECURITY_PREVIEW),
    testWorkspacePolicy: () =>
      Promise.resolve({ ...SECURITY_TEST, expiresAt: '2000-01-01T00:00:00.000Z' }),
  });
  await person().click(await view.findByRole('button', { name: 'Preview impact' }));
  await person().click(await view.findByRole('button', { name: 'Test these requirements' }));
  await view.findByText('This verification expired. Start a new verification to try again.');
  expect(
    (view.getByRole('button', { name: 'Save tested requirements' }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

test('an unmounted MFA confirmation cannot enqueue a second destructive request', async () => {
  const answer = Promise.withResolvers<{
    status: typeof SECURITY_STATUS;
    factor: typeof SECURITY_FACTOR;
  }>();
  let disabled = 0;
  const view = await open(
    {
      myWorkspaceMfa: () => Promise.resolve({ ...SECURITY_MFA, factor: SECURITY_FACTOR }),
      startWorkspaceMfaChallenge: () =>
        Promise.resolve({ ...SECURITY_CHALLENGE, purpose: 'disable' }),
      verifyWorkspaceMfa: () => answer.promise,
      disableWorkspaceMfa: () => {
        disabled++;
        return Promise.resolve(SECURITY_MFA);
      },
    },
    { path: '/w/acme/settings/workspace-mfa' },
  );
  await person().click(await view.findByRole('button', { name: 'Disconnect authenticator' }));
  await inputCode(view);
  view.unmount();
  await act(async () => {
    answer.resolve({ status: SECURITY_STATUS, factor: SECURITY_FACTOR });
    await answer.promise;
  });
  expect(disabled).toBe(0);
});

test('stale MFA state discards the one-time key and reads current inventory before another attempt', async () => {
  let reads = 0;
  const view = await open(
    {
      myWorkspaceMfa: () => {
        reads++;
        return Promise.resolve(SECURITY_MFA);
      },
      startWorkspaceMfaEnrollment: () => Promise.resolve(SECURITY_ENROLLMENT),
      verifyWorkspaceMfa: () =>
        Promise.reject(new ApiError(409, 'WORKSPACE_SECURITY_CHANGED', 'changed')),
    },
    { path: '/w/acme/settings/workspace-mfa' },
  );
  await person().click(await view.findByRole('button', { name: 'Set up authenticator' }));
  await inputCode(view);
  await view.findByRole('alert');
  expect(view.queryByRole('img', { name: 'Workspace authenticator QR code' })).toBeNull();
  await waitFor(() => {
    expect(reads).toBe(2);
  });
});

test('a real policy revision refresh preserves the successful save receipt', async () => {
  let policy = SECURITY_POLICY;
  const view = await open({
    workspacePolicy: () => Promise.resolve(policy),
    previewWorkspacePolicy: () => Promise.resolve(SECURITY_PREVIEW),
    testWorkspacePolicy: () => Promise.resolve(SECURITY_TEST),
    updateWorkspacePolicy: (_id, input) => {
      policy = { ...policy, ...input.policy, revision: IDS.bob, epoch: '2' };
      return Promise.resolve(policy);
    },
  });
  await person().selectOptions(
    await view.findByRole('combobox', { name: 'Apply requirements' }),
    'enforced',
  );
  await person().click(view.getByRole('button', { name: 'Preview impact' }));
  await person().click(await view.findByRole('button', { name: 'Test these requirements' }));
  await person().click(
    await view.findByRole('checkbox', {
      name: 'I understand that affected people must verify before returning to this workspace.',
    }),
  );
  await person().click(view.getByRole('button', { name: 'Save tested requirements' }));
  await view.findByText('Workspace security updated.');
  await waitFor(() => {
    expect(view.queryByRole('button', { name: 'Save tested requirements' })).toBeNull();
  });
  expect(view.getByText('Workspace security updated.')).toBeDefined();
});

test('an acknowledged test expiring while the owner reviews it disables saving', async () => {
  jest.useFakeTimers({ now: systemClock.now() });
  const user = userEvent.setup({
    document,
    advanceTimers: (milliseconds) => {
      jest.advanceTimersByTime(milliseconds);
    },
  });
  try {
    const view = await open({
      previewWorkspacePolicy: () => Promise.resolve(SECURITY_PREVIEW),
      testWorkspacePolicy: () =>
        Promise.resolve({
          ...SECURITY_TEST,
          expiresAt: new Date(systemClock.now().getTime() + 60_000).toISOString(),
        }),
    });
    await user.click(await view.findByRole('button', { name: 'Preview impact' }));
    await user.click(await view.findByRole('button', { name: 'Test these requirements' }));
    await user.click(
      await view.findByRole('checkbox', {
        name: 'I understand that affected people must verify before returning to this workspace.',
      }),
    );
    const save = view.getByRole('button', {
      name: 'Save tested requirements',
    }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    await act(async () => {
      jest.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(save.disabled).toBe(true);
    });
    view.unmount();
    view.world.client.clear();
  } finally {
    await act(async () => {
      jest.runOnlyPendingTimers();
      await Promise.resolve();
    });
    jest.useRealTimers();
  }
});

test('an administrator can preview impact while only owners are offered real tests and enforcement', async () => {
  let previews = 0;
  let tests = 0;
  const view = await open({
    me: () =>
      Promise.resolve({
        ...aSession(),
        memberships: aSession().memberships.map((member) => ({
          ...member,
          role: 'admin' as const,
        })),
      }),
    previewWorkspacePolicy: () => {
      previews++;
      return Promise.resolve(SECURITY_PREVIEW);
    },
    testWorkspacePolicy: () => {
      tests++;
      return Promise.resolve(SECURITY_TEST);
    },
  });
  await view.findByText(
    'Workspace owners test and apply requirements. You can preview their impact here.',
  );
  await person().click(view.getByRole('button', { name: 'Preview impact' }));
  await view.findByRole('heading', { name: 'Who needs to verify again' });
  expect(previews).toBe(1);
  expect(tests).toBe(0);
  expect(view.queryByRole('button', { name: 'Test these requirements' })).toBeNull();
  expect(view.queryByRole('button', { name: 'Save tested requirements' })).toBeNull();
  expect(view.queryByRole('heading', { name: 'Owner recovery' })).toBeNull();
  await expectNoAxeViolations(view.getByRole('main'));
});

test('a missing workspace address is validated locally and normalized before narrow lookup', async () => {
  const looked: string[] = [];
  const view = await open(
    {
      workspaceSecurityEntry: (slug) => {
        looked.push(slug);
        return Promise.resolve({ ...SECURITY_ENTRY, role: 'member' });
      },
    },
    { path: '/workspace-access' },
  );
  await person().click(await view.findByRole('button', { name: 'Continue to workspace' }));
  await view.findByText('Enter the workspace’s short address, such as acme.');
  expect(looked).toEqual([]);
  await person().type(view.getByRole('textbox', { name: 'Workspace address' }), ' AcMe ');
  await person().click(view.getByRole('button', { name: 'Continue to workspace' }));
  await view.findByRole('link', { name: 'Return to workspace' });
  expect(looked).toEqual(['acme']);
  expect(view.world.history.read().search).toBe('?workspace=acme');
  view.world.client.setQueryData(workspaceAccessRequiredKey(IDS.workspace, IDS.me), true);
  view.world.client.setQueryData(workspaceAccessRequiredKey(IDS.browse, IDS.me), true);
  fireEvent.click(view.getByRole('link', { name: 'Return to workspace' }));
  expect(
    view.world.client.getQueryData(workspaceAccessRequiredKey(IDS.workspace, IDS.me)),
  ).toBeUndefined();
  expect(view.world.client.getQueryData(workspaceAccessRequiredKey(IDS.browse, IDS.me))).toBe(true);
});

test('standalone lookup failure can retry and a later failed refresh retains only its own security receipt', async () => {
  let reads = 0;
  const view = await open(
    {
      workspaceSecurityEntry: () => {
        reads++;
        return reads === 1 || reads === 3
          ? Promise.reject(new ApiError(0, 'NETWORK', 'offline'))
          : Promise.resolve({ ...SECURITY_ENTRY, role: 'member' });
      },
    },
    { path: '/workspace-access?workspace=acme' },
  );
  await person().click(await view.findByRole('button', { name: 'Retry' }));
  await view.findByRole('link', { name: 'Return to workspace' });
  await person().click(view.getByRole('button', { name: 'Refresh security status' }));
  await person().click(await view.findByRole('button', { name: 'Retry' }));
  await view.findByRole('link', { name: 'Return to workspace' });
  expect(reads).toBe(4);
  expect(view.world.sockets.sockets).toHaveLength(0);
});

test('standalone company-required access offers the known workspace sign-in without opening chat', async () => {
  const view = await open(
    {
      workspaceSecurityEntry: () =>
        Promise.resolve({
          ...SECURITY_ENTRY,
          role: 'member',
          status: { ...SECURITY_STATUS, state: 'sign_in_required' },
        }),
    },
    { path: '/workspace-access?workspace=acme' },
  );
  await view.findByText('Company sign-in required');
  expect((view.getByRole('textbox', { name: 'Workspace address' }) as HTMLInputElement).value).toBe(
    'acme',
  );
  expect(view.world.sockets.sockets).toHaveLength(0);
});

test('owner recovery validates the complete opaque code, can cancel, and reloads narrow access after actual recovery', async () => {
  const seen: unknown[] = [];
  let recovered = false;
  const view = await open(
    {
      workspaceSecurityEntry: () =>
        Promise.resolve({
          ...SECURITY_ENTRY,
          status: { ...SECURITY_STATUS, state: recovered ? 'allowed' : 'expired' },
        }),
      recoverWorkspacePolicy: (_id, input) => {
        seen.push(input);
        recovered = true;
        return Promise.resolve(SECURITY_POLICY);
      },
    },
    { path: '/workspace-access?workspace=acme' },
  );
  await person().click(await view.findByRole('button', { name: 'Use an owner recovery code' }));
  await person().click(view.getByRole('button', { name: 'Cancel' }));
  expect(view.queryByRole('textbox', { name: 'Owner recovery code' })).toBeNull();
  await person().click(view.getByRole('button', { name: 'Use an owner recovery code' }));
  await person().click(view.getByRole('button', { name: 'Recover workspace access settings' }));
  await view.findByText('Paste the complete owner recovery code you saved.');
  expect(seen).toEqual([]);
  await person().type(
    view.getByRole('textbox', { name: 'Owner recovery code' }),
    IDS.bob + '.' + 'r'.repeat(43),
  );
  await person().click(view.getByRole('button', { name: 'Recover workspace access settings' }));
  await view.findByRole('link', { name: 'Return to workspace' });
  expect(seen).toEqual([{ revision: IDS.bob, recoveryCode: 'r'.repeat(43) }]);
  expect(view.queryByRole('textbox', { name: 'Owner recovery code' })).toBeNull();
});

test('a standalone owner can create and acknowledge recovery without retaining its secret in the lookup', async () => {
  let reads = 0;
  const view = await open(
    {
      workspaceSecurityEntry: () => {
        reads++;
        return Promise.resolve(SECURITY_ENTRY);
      },
      createWorkspacePolicyRecovery: () =>
        Promise.resolve({ revision: IDS.bob, recoveryCode: 'r'.repeat(43) }),
    },
    { path: '/workspace-access?workspace=acme' },
  );
  await person().click(await view.findByRole('button', { name: 'Create owner recovery code' }));
  await person().click(await view.findByRole('button', { name: 'I saved the recovery code' }));
  await waitFor(() => {
    expect(reads).toBe(2);
  });
  expect(
    JSON.stringify(view.world.client.getQueryData(['workspace-security', IDS.me, 'entry', 'acme'])),
  ).not.toContain('r'.repeat(43));
});

test('disconnecting a factor requires its observed challenge and refreshes the current inventory', async () => {
  let mine: typeof SECURITY_MFA = { ...SECURITY_MFA, factor: SECURITY_FACTOR };
  const seen: unknown[] = [];
  const view = await open(
    {
      myWorkspaceMfa: () => Promise.resolve(mine),
      startWorkspaceMfaChallenge: () =>
        Promise.resolve({ ...SECURITY_CHALLENGE, purpose: 'disable' }),
      verifyWorkspaceMfa: () =>
        Promise.resolve({ status: SECURITY_STATUS, factor: SECURITY_FACTOR }),
      disableWorkspaceMfa: (_id, input) => {
        seen.push(input);
        mine = SECURITY_MFA;
        return Promise.resolve(mine);
      },
    },
    { path: '/w/acme/settings/workspace-mfa' },
  );
  await person().click(await view.findByRole('button', { name: 'Disconnect authenticator' }));
  await inputCode(view);
  await view.findByText('Not connected');
  expect(seen).toEqual([
    {
      policyRevision: IDS.alice,
      factorRevision: SECURITY_FACTOR.revision,
      authorizationChallengeId: SECURITY_CHALLENGE.challengeId,
    },
  ]);
});

test('replacement confirmation swaps the factor only after the new authenticator code succeeds', async () => {
  let mine: typeof SECURITY_MFA = { ...SECURITY_MFA, factor: SECURITY_FACTOR };
  let verifies = 0;
  let enrolls = 0;
  const replacement = { ...SECURITY_FACTOR, id: IDS.incidents, revision: IDS.dm };
  const view = await open(
    {
      myWorkspaceMfa: () => Promise.resolve(mine),
      startWorkspaceMfaChallenge: () =>
        Promise.resolve({ ...SECURITY_CHALLENGE, purpose: 'rotate' }),
      startWorkspaceMfaEnrollment: () => {
        enrolls++;
        return Promise.resolve({
          ...SECURITY_ENROLLMENT,
          factor: { ...SECURITY_ENROLLMENT.factor, id: replacement.id },
          challenge: { ...SECURITY_ENROLLMENT.challenge, challengeId: 'e'.repeat(43) },
        });
      },
      verifyWorkspaceMfa: () => {
        verifies++;
        if (verifies === 1)
          return Promise.resolve({ status: SECURITY_STATUS, factor: SECURITY_FACTOR });
        mine = { ...mine, factor: replacement, recoveryCodesRemaining: 10 };
        return Promise.resolve({
          status: SECURITY_STATUS,
          factor: replacement,
          recoveryCodes: SECURITY_CODES,
        });
      },
    },
    { path: '/w/acme/settings/workspace-mfa' },
  );
  await person().click(await view.findByRole('button', { name: 'Replace authenticator' }));
  await inputCode(view);
  await view.findByRole('img', { name: 'Workspace authenticator QR code' });
  expect(mine.factor?.id).toBe(SECURITY_FACTOR.id);
  await inputCode(view);
  await view.findByRole('heading', { name: 'Keep your recovery codes' });
  await person().click(view.getByRole('button', { name: 'I saved these codes' }));
  await view.findByRole('button', { name: 'Replace authenticator' });
  expect(mine.factor?.id).toBe(replacement.id);
  expect(enrolls).toBe(1);
  expect(verifies).toBe(2);
});

test('replacing recovery codes authenticates the current factor and displays the new batch once', async () => {
  const seen: unknown[] = [];
  const view = await open(
    {
      myWorkspaceMfa: () => Promise.resolve({ ...SECURITY_MFA, factor: SECURITY_FACTOR }),
      startWorkspaceMfaChallenge: () =>
        Promise.resolve({ ...SECURITY_CHALLENGE, purpose: 'recovery_codes' }),
      verifyWorkspaceMfa: () =>
        Promise.resolve({ status: SECURITY_STATUS, factor: SECURITY_FACTOR }),
      newWorkspaceMfaRecoveryCodes: (_id, input) => {
        seen.push(input);
        return Promise.resolve(SECURITY_CODES);
      },
    },
    { path: '/w/acme/settings/workspace-mfa' },
  );
  await person().click(await view.findByRole('button', { name: 'Replace recovery codes' }));
  await inputCode(view);
  await view.findByRole('heading', { name: 'Keep your recovery codes' });
  await person().click(view.getByRole('button', { name: 'I saved these codes' }));
  await view.findByRole('button', { name: 'Replace recovery codes' });
  expect(seen).toEqual([
    {
      policyRevision: IDS.alice,
      factorRevision: SECURITY_FACTOR.revision,
      authorizationChallengeId: SECURITY_CHALLENGE.challengeId,
    },
  ]);
});

test('cancelling workspace and global challenges discards typed values without verification', async () => {
  let verifies = 0;
  const view = await open(
    {
      myWorkspaceMfa: () =>
        Promise.resolve({ ...SECURITY_MFA, factor: SECURITY_FACTOR, globalMfaAvailable: true }),
      startWorkspaceMfaChallenge: () => Promise.resolve(SECURITY_CHALLENGE),
      verifyWorkspaceMfa: () => {
        verifies++;
        return Promise.resolve({ status: SECURITY_STATUS, factor: SECURITY_FACTOR });
      },
    },
    { path: '/w/acme/settings/workspace-mfa' },
  );
  await person().click(await view.findByRole('button', { name: 'Verify access' }));
  await person().click(view.getByRole('button', { name: 'Use a recovery code instead' }));
  await person().type(view.getByRole('textbox', { name: 'Recovery code' }), 'short');
  await person().click(view.getByRole('button', { name: 'Verify code' }));
  await view.findByText('Enter one of your 22-character workspace recovery codes.');
  await person().click(view.getByRole('button', { name: 'Use authenticator app instead' }));
  expect(
    (view.getByRole('textbox', { name: 'Authenticator code' }) as HTMLInputElement).value,
  ).toBe('');
  await person().click(view.getByRole('button', { name: 'Cancel' }));
  await person().click(view.getByRole('button', { name: 'Verify with account authenticator' }));
  await inputCode(view, '123');
  await view.findByText('Enter the six digits from your authenticator app.');
  await person().click(view.getByRole('button', { name: 'Cancel' }));
  expect(verifies).toBe(0);
});

test('an expired enrollment starts over and can be cancelled before any code is spent', async () => {
  let enrolls = 0;
  const view = await open(
    {
      startWorkspaceMfaEnrollment: () => {
        enrolls++;
        return Promise.resolve(
          enrolls === 1
            ? {
                ...SECURITY_ENROLLMENT,
                challenge: {
                  ...SECURITY_ENROLLMENT.challenge,
                  expiresAt: '2000-01-01T00:00:00.000Z',
                },
              }
            : SECURITY_ENROLLMENT,
        );
      },
    },
    { path: '/w/acme/settings/workspace-mfa' },
  );
  await person().click(await view.findByRole('button', { name: 'Set up authenticator' }));
  await person().click(await view.findByRole('button', { name: 'Start new verification' }));
  await view.findByRole('button', { name: 'Verify code' });
  expect(enrolls).toBe(2);
  await person().click(view.getByRole('button', { name: 'Cancel' }));
  await view.findByText('Not connected');
});

test('an expired replacement setup restarts old-factor authorization instead of bypassing it', async () => {
  let challenges = 0;
  let enrolls = 0;
  const view = await open(
    {
      myWorkspaceMfa: () => Promise.resolve({ ...SECURITY_MFA, factor: SECURITY_FACTOR }),
      startWorkspaceMfaChallenge: () => {
        challenges++;
        return Promise.resolve({ ...SECURITY_CHALLENGE, purpose: 'rotate' });
      },
      verifyWorkspaceMfa: () =>
        Promise.resolve({ status: SECURITY_STATUS, factor: SECURITY_FACTOR }),
      startWorkspaceMfaEnrollment: () => {
        enrolls++;
        return Promise.resolve({
          ...SECURITY_ENROLLMENT,
          challenge: { ...SECURITY_ENROLLMENT.challenge, expiresAt: '2000-01-01T00:00:00.000Z' },
        });
      },
    },
    { path: '/w/acme/settings/workspace-mfa' },
  );
  await person().click(await view.findByRole('button', { name: 'Replace authenticator' }));
  await inputCode(view);
  await person().click(await view.findByRole('button', { name: 'Start new verification' }));
  await view.findByRole('button', { name: 'Verify code' });
  expect(challenges).toBe(2);
  expect(enrolls).toBe(1);
  await person().click(view.getByRole('button', { name: 'Cancel' }));
});

test('an expired verification requests a fresh challenge with the same purpose', async () => {
  let challenges = 0;
  const view = await open(
    {
      myWorkspaceMfa: () => Promise.resolve({ ...SECURITY_MFA, factor: SECURITY_FACTOR }),
      startWorkspaceMfaChallenge: () => {
        challenges++;
        return Promise.resolve(
          challenges === 1
            ? { ...SECURITY_CHALLENGE, expiresAt: '2000-01-01T00:00:00.000Z' }
            : SECURITY_CHALLENGE,
        );
      },
    },
    { path: '/w/acme/settings/workspace-mfa' },
  );
  await person().click(await view.findByRole('button', { name: 'Verify access' }));
  await person().click(await view.findByRole('button', { name: 'Start new verification' }));
  await view.findByRole('button', { name: 'Verify code' });
  expect(challenges).toBe(2);
});

test.each([
  [new LibraryFailure(0, 'NETWORK'), 'Check your connection and try again.'],
  [
    new LibraryFailure(429, 'RATE_LIMITED'),
    'Too many attempts. Wait before starting another verification.',
  ],
  [
    new LibraryFailure(502, 'MALFORMED'),
    'Something went wrong on our side. Try again in a moment.',
  ],
  [
    new LibraryFailure(400, 'INVALID_TOTP'),
    'The code was not accepted. Use a new code from the app or an unused recovery code.',
  ],
] as const)(
  'native account verification refusal %s remains visible and retryable',
  async (failure, text) => {
    let tries = 0;
    const view = await open(
      {
        myWorkspaceMfa: () => Promise.resolve({ ...SECURITY_MFA, globalMfaAvailable: true }),
        verifySignInCode: () => {
          tries++;
          return tries === 1 ? Promise.reject(failure) : Promise.resolve();
        },
      },
      { path: '/w/acme/settings/workspace-mfa' },
    );
    await person().click(
      await view.findByRole('button', { name: 'Verify with account authenticator' }),
    );
    await inputCode(view);
    await view.findByText(text);
    await person().click(view.getByRole('button', { name: 'Verify code' }));
    await view.findByText('Verification completed.');
    expect(tries).toBe(2);
  },
);

test('one-time recovery remains manually usable when copying fails', async () => {
  const view = await open(
    {
      createWorkspacePolicyRecovery: () =>
        Promise.resolve({ revision: IDS.bob, recoveryCode: 'r'.repeat(43) }),
    },
    { copy: () => Promise.reject(new Error('clipboard unavailable')) },
  );
  await person().click(await view.findByRole('button', { name: 'Create owner recovery code' }));
  await person().click(
    within(await view.findByRole('region', { name: 'Owner recovery' })).getByRole('button', {
      name: 'Copy',
    }),
  );
  await view.findByText("Couldn't copy. Select the text and copy it yourself.");
  expect(view.getByText(IDS.bob + '.' + 'r'.repeat(43))).toBeDefined();
});

test('MFA inventory recovers from an initial outage and a later failed verification refresh', async () => {
  let reads = 0;
  const view = await open(
    {
      myWorkspaceMfa: () => {
        reads++;
        return reads === 1 || reads === 3
          ? Promise.reject(new ApiError(0, 'NETWORK', 'offline'))
          : Promise.resolve({ ...SECURITY_MFA, factor: SECURITY_FACTOR });
      },
      startWorkspaceMfaChallenge: () => Promise.resolve(SECURITY_CHALLENGE),
      verifyWorkspaceMfa: () =>
        Promise.resolve({ status: SECURITY_STATUS, factor: SECURITY_FACTOR }),
    },
    { path: '/w/acme/settings/workspace-mfa' },
  );
  await person().click(await view.findByRole('button', { name: 'Retry' }));
  await person().click(await view.findByRole('button', { name: 'Verify access' }));
  await inputCode(view);
  await person().click(await view.findByRole('button', { name: 'Retry' }));
  await view.findByRole('button', { name: 'Verify access' });
  expect(reads).toBe(4);
});

test('policy reads can retry an outage and retain disabled last-known controls during a failed refresh', async () => {
  let reads = 0;
  const view = await open({
    workspacePolicy: () => {
      reads++;
      return reads === 1 || reads === 3
        ? Promise.reject(new ApiError(0, 'NETWORK', 'offline'))
        : Promise.resolve(SECURITY_POLICY);
    },
  });
  await person().click(await view.findByRole('button', { name: 'Retry' }));
  await view.findByRole('button', { name: 'Preview impact' });
  await person().click(view.getByRole('button', { name: 'Refresh security status' }));
  const retry = await view.findByRole('button', { name: 'Retry' });
  expect((view.getByRole('button', { name: 'Preview impact' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  await person().click(retry);
  await waitFor(() => {
    expect(
      (view.getByRole('button', { name: 'Preview impact' }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
  expect(reads).toBe(4);
});

test('company provider loading can retry and invalid or missing providers cannot reach preview', async () => {
  let providers = 0;
  const sent: unknown[] = [];
  const second = {
    ...COMPANY_CONNECTION,
    id: IDS.dm,
    name: 'Branch identity',
    ready: true,
    enabled: true,
  };
  const current = {
    ...SECURITY_POLICY,
    signIn: 'company' as const,
    allowedConnectionIds: [IDS.incidents],
  };
  const view = await open({
    workspacePolicy: () => Promise.resolve(current),
    companyConnections: () => {
      providers++;
      return providers === 1
        ? Promise.reject(new ApiError(0, 'NETWORK', 'offline'))
        : Promise.resolve({
            data: [{ ...COMPANY_CONNECTION, ready: true, enabled: true }, second],
            nextCursor: null,
          });
    },
    previewWorkspacePolicy: (_id, input) => {
      sent.push(input);
      return Promise.resolve(SECURITY_PREVIEW);
    },
  });
  await person().click(await view.findByRole('button', { name: 'Preview impact' }));
  await view.findByText('Check the selected providers and time limits before continuing.');
  expect(sent).toEqual([]);
  await person().click(view.getByRole('button', { name: 'Retry' }));
  const group = await view.findByRole('group', { name: 'Allowed company providers' });
  await person().click(
    within(group).getByRole('checkbox', { name: 'Unavailable — choose another provider' }),
  );
  await person().click(within(group).getByRole('checkbox', { name: COMPANY_CONNECTION.name }));
  await person().click(within(group).getByRole('checkbox', { name: 'Branch identity' }));
  await person().click(within(group).getByRole('checkbox', { name: COMPANY_CONNECTION.name }));
  await person().click(view.getByRole('button', { name: 'Preview impact' }));
  await view.findByRole('heading', { name: 'Who needs to verify again' });
  expect(sent[0]).toMatchObject({ policy: { signIn: 'company', allowedConnectionIds: [IDS.dm] } });
  expect(providers).toBe(2);
});

test('policy time limits are checked, can be cleared, and impact pages retain earlier affected people', async () => {
  const seen: unknown[] = [];
  const view = await open({
    previewWorkspacePolicy: (_id, input) => {
      seen.push(input);
      return Promise.resolve({
        ...SECURITY_PREVIEW,
        examples: {
          data: [
            {
              userId: input.before === undefined ? IDS.alice : IDS.bob,
              displayName: input.before === undefined ? 'Affected Alice' : 'Affected Bob',
              accessKind: 'member',
              state: 'expired',
              affectedSessions: 1,
            },
          ],
          nextCursor: input.before === undefined ? IDS.bob : null,
        },
      });
    },
  });
  const idle = await view.findByRole('spinbutton', {
    name: 'End workspace access after inactivity (minutes)',
  });
  await person().type(idle, '1');
  await person().click(view.getByRole('button', { name: 'Preview impact' }));
  await view.findByText('Check the selected providers and time limits before continuing.');
  expect(seen).toEqual([]);
  await person().clear(idle);
  await person().type(idle, '15');
  await person().type(
    view.getByRole('spinbutton', { name: 'Ask for a new sign-in after (hours)' }),
    '8',
  );
  const mfa = view.getByRole('spinbutton', {
    name: 'Ask for a new authenticator code after (minutes)',
  });
  await person().type(mfa, '30');
  await person().click(mfa);
  await person().keyboard('{End}{Backspace}{Backspace}');
  await person().click(view.getByRole('button', { name: 'Preview impact' }));
  await view.findByText('Affected Alice');
  await person().click(view.getByRole('button', { name: 'Show more affected people' }));
  await view.findByText('Affected Bob');
  expect(view.getByText('Affected Alice')).toBeDefined();
  expect(seen).toEqual([
    {
      revision: IDS.alice,
      policy: {
        mode: 'off',
        signIn: 'any',
        allowedConnectionIds: [],
        requireMfa: false,
        idleMinutes: 15,
        maxAgeHours: 8,
        mfaMaxAgeMinutes: null,
      },
    },
    {
      revision: IDS.alice,
      policy: {
        mode: 'off',
        signIn: 'any',
        allowedConnectionIds: [],
        requireMfa: false,
        idleMinutes: 15,
        maxAgeHours: 8,
        mfaMaxAgeMinutes: null,
      },
      before: IDS.bob,
    },
  ]);
});

test.each(['sign_in_required', 'expired'] as const)(
  'policy test requiring %s offers a safe sign-in and resumes the same receipt',
  async (state) => {
    const seen: unknown[] = [];
    const view = await open({
      previewWorkspacePolicy: () => Promise.resolve(SECURITY_PREVIEW),
      testWorkspacePolicy: (_id, input) => {
        seen.push(input);
        return Promise.resolve({
          ...SECURITY_TEST,
          status: { ...SECURITY_STATUS, state: seen.length === 1 ? state : 'allowed' },
        });
      },
    });
    await person().click(await view.findByRole('button', { name: 'Preview impact' }));
    await person().click(await view.findByRole('button', { name: 'Test these requirements' }));
    const signin = await view.findByRole('link', { name: 'Sign in again' });
    expect(signin.getAttribute('href')).toBe(
      '/sign-in?workspace=acme&independent=' + (state === 'expired' ? '1' : '0'),
    );
    await person().click(view.getByRole('button', { name: 'Check this test again' }));
    await view.findByText('Your access passed this test. These requirements are ready to save.');
    expect(seen[1]).toMatchObject({
      testId: SECURITY_TEST.testId,
      testToken: SECURITY_TEST.testToken,
    });
  },
);

test('a changed policy during enforcement discards both preview and exact test before another attempt', async () => {
  let reads = 0;
  const view = await open({
    workspacePolicy: () => {
      reads++;
      return Promise.resolve(SECURITY_POLICY);
    },
    previewWorkspacePolicy: () => Promise.resolve(SECURITY_PREVIEW),
    testWorkspacePolicy: () => Promise.resolve(SECURITY_TEST),
    updateWorkspacePolicy: () =>
      Promise.reject(new ApiError(409, 'WORKSPACE_SECURITY_CHANGED', 'changed')),
  });
  await person().click(await view.findByRole('button', { name: 'Preview impact' }));
  await person().click(await view.findByRole('button', { name: 'Test these requirements' }));
  await person().click(
    await view.findByRole('checkbox', {
      name: 'I understand that affected people must verify before returning to this workspace.',
    }),
  );
  await person().click(view.getByRole('button', { name: 'Save tested requirements' }));
  await view.findByText('Security settings changed. Refresh and start verification again.');
  expect(view.queryByRole('button', { name: 'Save tested requirements' })).toBeNull();
  expect(view.queryByRole('heading', { name: 'Who needs to verify again' })).toBeNull();
  expect(reads).toBe(2);
});

test('settings owner recovery can turn requirements off and publish the freshly read policy', async () => {
  let policy = SECURITY_POLICY;
  let reads = 0;
  const view = await open({
    workspacePolicy: () => {
      reads++;
      return Promise.resolve(policy);
    },
    recoverWorkspacePolicy: () => {
      policy = { ...SECURITY_POLICY, revision: IDS.bob, epoch: '2' };
      return Promise.resolve(policy);
    },
  });
  await person().click(await view.findByRole('button', { name: 'Use an owner recovery code' }));
  await person().type(
    view.getByRole('textbox', { name: 'Owner recovery code' }),
    IDS.bob + '.' + 'r'.repeat(43),
  );
  await person().click(view.getByRole('button', { name: 'Recover workspace access settings' }));
  await view.findByText(
    'Workspace requirements are off. Verify your current access before returning.',
  );
  expect(reads).toBe(2);
});

test('a company recovery preparation can be cancelled without changing policy or leaving a ticket in cache', async () => {
  const view = await open({
    me: () => Promise.resolve({ ...aSession(), companyWorkspaceId: IDS.workspace }),
    testWorkspacePolicy: () =>
      Promise.resolve({
        ...SECURITY_TEST,
        status: { ...SECURITY_STATUS, state: 'sign_in_required' },
      }),
  });
  await person().click(await view.findByRole('button', { name: 'Prepare a new recovery code' }));
  await view.findByRole('link', { name: 'Sign in in a new tab' });
  await person().click(view.getByRole('button', { name: 'Cancel' }));
  await view.findByRole('button', { name: 'Prepare a new recovery code' });
  expect(
    JSON.stringify(
      view.world.client
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
    ),
  ).not.toContain(SECURITY_TEST.testToken);
});

test('signed-out remediation preserves its workspace through independent password sign-in', async () => {
  let signed = false;
  const view = await open(
    {
      me: () =>
        signed
          ? Promise.resolve(aSession())
          : Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'sign in')),
      ownAdmission: () => Promise.resolve({ state: null }),
      authMethods: () =>
        Promise.resolve({
          github: false,
          email: false,
          oidc: null,
          google: false,
          signUp: 'invite-only',
          password: true,
        }),
      signInWithPassword: () => {
        signed = true;
        return Promise.resolve('signed-in');
      },
    },
    { path: '/workspace-access?workspace=acme' },
  );
  await view.findByRole('heading', { name: 'Sign in to Purlay' });
  expect(view.world.history.read().search).toBe('?independent=1&workspace=acme');
  await person().type(view.getByRole('textbox', { name: 'Email address' }), 'owner@example.test');
  await person().type(view.getByLabelText('Password'), 'correct fixture password');
  await person().click(view.getByRole('button', { name: 'Sign in' }));
  await view.findByRole('heading', { name: 'Verify workspace access' });
  expect(view.world.history.read().search).toBe('?workspace=acme');
});
