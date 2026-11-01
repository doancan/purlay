/**
 * The person the server holds back until their second step is on (D-239, `UX.md` §11), through the real frame
 * at a workspace's address: nothing of the workspace is drawn and nothing of it is asked for — only the card that
 * turns it on, which has nothing to turn off, and Sign out. Turned on, the backup codes stay on the screen until
 * Done; then the identity is read again and the workspace is drawn, with no sign-in in between. In both
 * languages, and the accessibility audit at each step.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { MeResponse, TwoFactorEnrolment } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import type { Api } from '../../data/api';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { aSession, aSignedInApi } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';

installDom();

type View = Awaited<ReturnType<typeof renderApp>>;

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 6; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const ENROLMENT: TwoFactorEnrolment = {
  totpURI:
    'otpauth://totp/Purlay%20(purlay.test):admin%40example.test?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Purlay+(purlay.test)&digits=6&period=30',
  backupCodes: Array.from({ length: 10 }, (_, n) => `code${String(n)}-abcde`),
};

const held = (owing: () => boolean): MeResponse => ({ ...aSession(), mustEnrolTwoFactor: owing() });

/** An API that answers only what the enrolment needs, and fails the test on anything of the workspace's. */
const anEnrolmentApi = (
  owing: () => boolean,
  over: Partial<Api> = {},
): { readonly api: Api; readonly reached: string[] } => {
  const reached: string[] = [];
  const api = aSignedInApi({
    me: () => Promise.resolve(held(owing)),
    workspaces: () => {
      reached.push('workspaces');
      return Promise.resolve(aSession().memberships);
    },
    ...over,
  });
  return { api, reached };
};

const open = async (api: Api, locale: 'en' | 'tr' = 'en'): Promise<View> => {
  const view = await renderApp(<Outlet />, { path: '/w/acme', api, locale });
  await settle();
  return view;
};

describe('the screen that turns on two-step verification for a person the server holds back', () => {
  test('draws nothing of the workspace and asks nothing of it: the card, with nothing to turn off, and Sign out', async () => {
    const { api, reached } = anEnrolmentApi(() => true);
    const view = await open(api);
    expect(
      await view.findByRole('heading', { level: 1, name: 'Turn on two-step verification' }),
    ).toBeDefined();
    const card = within(view.getByRole('region', { name: 'Two-step verification' }));
    expect(card.getByRole('button', { name: 'Turn on…' })).toBeDefined();
    expect(card.queryByRole('button', { name: 'Turn off…' })).toBeNull();
    expect(view.getByRole('button', { name: 'Sign out' })).toBeDefined();
    expect(view.queryByRole('navigation')).toBeNull();
    expect(reached).toEqual([]);
    await expectNoAxeViolations(view.container);
    view.unmount();
  });

  test('says it in Turkish too', async () => {
    const { api } = anEnrolmentApi(() => true);
    const view = await open(api, 'tr');
    expect(
      await view.findByRole('heading', { level: 1, name: 'İki adımlı doğrulamayı aç' }),
    ).toBeDefined();
    expect(view.getByRole('button', { name: 'Çıkış yap' })).toBeDefined();
    view.unmount();
  });

  test('turned on, the backup codes stay until Done; then the workspace is drawn on the same session', async () => {
    let owing = true;
    let signedOut = false;
    const { api } = anEnrolmentApi(() => owing, {
      startTwoFactor: () => Promise.resolve(ENROLMENT),
      confirmTwoFactor: () => {
        owing = false;
        return Promise.resolve();
      },
      signOut: () => {
        signedOut = true;
        return Promise.resolve();
      },
    });
    const view = await open(api);
    const card = within(await view.findByRole('region', { name: 'Two-step verification' }));
    await person().click(card.getByRole('button', { name: 'Turn on…' }));
    await settle();
    await person().type(card.getByLabelText('Your password'), 'the right one 123');
    await person().click(card.getByRole('button', { name: 'Continue' }));
    await settle();
    await person().type(card.getByLabelText('Code from the app'), '123456');
    await person().click(card.getByRole('button', { name: 'Turn on' }));
    await settle();
    // On now, and the codes are still there: the identity is not read again before Done.
    expect(card.getAllByRole('listitem')).toHaveLength(ENROLMENT.backupCodes.length);
    expect(
      view.getByRole('heading', { level: 1, name: 'Turn on two-step verification' }),
    ).toBeDefined();
    await expectNoAxeViolations(view.container);
    await person().click(card.getByRole('button', { name: 'Done' }));
    await settle();
    expect(view.queryByRole('heading', { name: 'Turn on two-step verification' })).toBeNull();
    expect(await view.findByText('acme-eng')).toBeDefined();
    expect(signedOut).toBe(false);
    view.unmount();
  });

  test('Sign out signs out, and goes to the sign-in screen', async () => {
    let signedOut = false;
    const { api } = anEnrolmentApi(() => true, {
      me: () =>
        signedOut
          ? Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'signed out'))
          : Promise.resolve(held(() => true)),
      signOut: () => {
        signedOut = true;
        return Promise.resolve();
      },
    });
    const view = await open(api);
    await person().click(await view.findByRole('button', { name: 'Sign out' }));
    await settle();
    expect(signedOut).toBe(true);
    expect(view.world.history.stack.at(-1)).toBe('/sign-in');
    view.unmount();
  });
});
