/**
 * What the wizard's tests share: a state, a client that fails every call a test did not expect, and a
 * way to open the wizard over them. A test file, not shipped: nothing outside `*.test.tsx` imports it.
 */
import type { SetupState } from '@purlay/types';
import { act } from '@testing-library/react';
import { anApi } from '../../testing/fake-api';
import { renderApp, type WorldOptions } from '../../testing/render';
import type { Api } from '../../data/api';
import { SetupFailure, type SetupClient } from './client';
import { SetupScreen } from './setup-screen';

export const ORIGIN = 'https://purlay.test';

export const aState = (over: Partial<SetupState> = {}): SetupState => ({
  steps: ['claim'],
  appUrl: ORIGIN,
  githubCallbackUrl: `${ORIGIN}/auth/callback/github`,
  settings: {
    signUp: 'invite-only',
    requireTwoFactor: false,
    passwordSignIn: true,
    sessionIdleTimeoutHours: null,
    sessionMaxAgeDays: null,
    github: null,
    oidc: null,
    smtp: null,
    githubApp: null,
    workspaceCreators: { kind: 'first' },
    setupCompletedAt: null,
  },
  needsReentry: [],
  channels: { github: false, email: false },
  admin: null,
  workspace: null,
  canFinish: false,
  finishProblems: ['out-of-order'],
  ...over,
});

const unexpected = (name: string) => (): Promise<never> =>
  Promise.reject(new Error(`the test did not expect client.${name} to be called`));

export const aClient = (over: Partial<SetupClient> = {}): SetupClient => ({
  state: unexpected('state'),
  claim: unexpected('claim'),
  admin: unexpected('admin'),
  confirmAddress: unexpected('confirmAddress'),
  policy: unexpected('policy'),
  github: unexpected('github'),
  skipGithub: unexpected('skipGithub'),
  smtp: unexpected('smtp'),
  skipSmtp: unexpected('skipSmtp'),
  resendSmtp: unexpected('resendSmtp'),
  workspace: unexpected('workspace'),
  invite: unexpected('invite'),
  finish: unexpected('finish'),
  verify: unexpected('verify'),
  ...over,
});

/** The server's answer for a browser that holds no setup. */
export const unheld = (): Promise<never> =>
  Promise.reject(new SetupFailure(404, 'SETUP_UNAVAILABLE', 'no'));

export const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

/** Opens the wizard over a client, on a server whose status is `status`. */
export const openSetup = async (
  client: SetupClient,
  options: WorldOptions & {
    readonly status?: { readonly open: boolean; readonly appUrl: string };
    readonly onStatus?: () => void;
  } = {},
): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  const { status = { open: true, appUrl: ORIGIN }, onStatus, ...world } = options;
  const api: Api =
    world.api ??
    anApi({
      setupStatus: () => {
        onStatus?.();
        return Promise.resolve(status);
      },
    });
  const view = await renderApp(<SetupScreen client={client} />, { ...world, api });
  await settle();
  return view;
};
