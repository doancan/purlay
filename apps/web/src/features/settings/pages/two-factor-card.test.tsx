/**
 * Two-step verification on Sessions & account (D-236), through the real frame at the page's address: drawn only
 * for an account with a password; turned on by the password, then a code from the app, after which the backup
 * codes are shown once and copied; turned off and new backup codes by the password; each refusal said where it
 * belongs; and the accessibility audit at every step.
 */
import { describe, expect, test } from 'bun:test';
import { act, fireEvent, within } from '@testing-library/react';
import type { BoundFunctions, queries } from '@testing-library/react';
import type { MySignIn, TwoFactorEnrolment } from '@purlay/types';
import { Outlet } from '../../../app/outlet';
import type { Api } from '../../../data/api';
import { LibraryFailure } from '../../../data/errors';
import { expectNoAxeViolations } from '../../../testing/axe';
import { installDom } from '../../../testing/dom';
import { aSignedInApi } from '../../../testing/fixtures';
import { renderApp } from '../../../testing/render';
import { person } from '../../../testing/user';
import { Toaster } from '../../../ui/toast';

installDom();

type Scope = BoundFunctions<typeof queries>;
type View = Awaited<ReturnType<typeof renderApp>>;

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
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

const signIn = (overrides: Partial<MySignIn> = {}): MySignIn => ({
  email: 'admin@example.test',
  emailLinks: true,
  hasPassword: true,
  github: null,
  oidc: false,
  twoFactor: false,
  ...overrides,
});

const open = async (api: Partial<Api>, locale: 'en' | 'tr' = 'en'): Promise<View> => {
  const view = await renderApp(
    <>
      <Outlet />
      <Toaster dismissLabel="Close" />
    </>,
    { path: '/w/acme/settings/account', api: aSignedInApi(api), locale },
  );
  await settle();
  await view.findByRole('heading', {
    level: 1,
    name: locale === 'en' ? 'Sessions & account' : 'Oturumlar ve hesap',
  });
  return view;
};

const card = (view: View): Scope =>
  within(view.getByRole('region', { name: 'Two-step verification' }));

const press = async (scope: Scope, name: string): Promise<void> => {
  await person().click(scope.getByRole('button', { name }));
  await settle();
};

const typeInto = async (scope: Scope, label: string, words: string): Promise<void> => {
  await person().type(scope.getByLabelText(label), words);
};

describe('two-step verification', () => {
  test('is drawn only for an account with a password, says what it guards, and is off', async () => {
    const without = await open({ mySignIn: () => Promise.resolve(signIn({ hasPassword: false })) });
    expect(without.queryByRole('region', { name: 'Two-step verification' })).toBeNull();
    without.unmount();

    const view = await open({ mySignIn: () => Promise.resolve(signIn()) });
    const here = card(view);
    expect(here.getByText('Off')).toBeDefined();
    expect(
      here.getByText(
        'It protects your password. Signing in with GitHub, single sign-on or an emailed link relies on that provider’s own security.',
      ),
    ).toBeDefined();
    expect(here.getByRole('button', { name: 'Turn on…' })).toBeDefined();
    expect(here.queryByRole('button', { name: 'Turn off…' })).toBeNull();
    await expectNoAxeViolations(view.container);
  });

  test('turning it on: the password, the key three ways, a right code, then the backup codes once, copied', async () => {
    let enabled = false;
    let reads = 0;
    const passwords: string[] = [];
    const codes: string[] = [];
    const view = await open({
      mySignIn: () => {
        reads += 1;
        return Promise.resolve(signIn({ twoFactor: enabled }));
      },
      startTwoFactor: (password) => {
        passwords.push(password);
        return password === 'the right one 123'
          ? Promise.resolve(ENROLMENT)
          : Promise.reject(new LibraryFailure(400, 'INVALID_PASSWORD'));
      },
      confirmTwoFactor: (code) => {
        codes.push(code);
        if (code !== '123456') return Promise.reject(new LibraryFailure(401, 'INVALID_CODE'));
        enabled = true;
        return Promise.resolve();
      },
    });
    const here = card(view);
    await press(here, 'Turn on…');
    expect(here.getByText('Confirm it is you with your password.')).toBeDefined();
    await expectNoAxeViolations(view.container);

    await typeInto(here, 'Your password', 'not it');
    await press(here, 'Continue');
    expect(here.getByText('That is not your password.')).toBeDefined();
    expect(here.getByLabelText('Your password').getAttribute('aria-invalid')).toBe('true');

    await person().clear(here.getByLabelText('Your password'));
    await typeInto(here, 'Your password', 'the right one 123');
    await press(here, 'Continue');
    expect(passwords).toEqual(['not it', 'the right one 123']);
    const qr = here.getByRole('img', { name: 'QR code for your authenticator app' });
    expect(qr.querySelector('path')?.getAttribute('d')).toMatch(/^M/);
    expect(here.getByText('JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP')).toBeDefined();
    expect(
      here
        .getByRole('link', { name: 'Open in an authenticator app on this device' })
        .getAttribute('href'),
    ).toBe(ENROLMENT.totpURI);
    await expectNoAxeViolations(view.container);

    await typeInto(here, 'Code from the app', '000000');
    await press(here, 'Turn on');
    expect(here.getByText('That code is not right. Check the app and try again.')).toBeDefined();
    await person().clear(here.getByLabelText('Code from the app'));
    await typeInto(here, 'Code from the app', '123 456');
    await press(here, 'Turn on');
    expect(codes).toEqual(['000000', '123456']);

    const shown = within(here.getByRole('region', { name: 'Backup codes' }));
    expect(shown.getByRole('status').textContent).toBe('Two-step verification is on.');
    expect(shown.getAllByRole('listitem').map((item) => item.textContent)).toEqual(
      ENROLMENT.backupCodes,
    );
    await expectNoAxeViolations(view.container);
    const user = person();
    await user.click(here.getByRole('button', { name: 'Copy codes' }));
    await settle();
    expect(await navigator.clipboard.readText()).toBe(ENROLMENT.backupCodes.join('\n'));
    expect(view.getByText('Copied')).toBeDefined();

    await press(here, 'Done');
    expect(here.queryByRole('region', { name: 'Backup codes' })).toBeNull();
    expect(here.getByText('On')).toBeDefined();
    expect(here.getByRole('status').textContent).toBe('Two-step verification is on.');
    expect(reads).toBeGreaterThan(1);
  });

  test('when on: turning it off takes the password, and says so', async () => {
    let enabled = true;
    const sent: string[] = [];
    const view = await open({
      mySignIn: () => Promise.resolve(signIn({ twoFactor: enabled })),
      stopTwoFactor: (password) => {
        sent.push(password);
        enabled = false;
        return Promise.resolve();
      },
    });
    const here = card(view);
    expect(here.getByText('On')).toBeDefined();
    await press(here, 'Turn off…');
    expect(
      here.getByText('Confirm with your password. Your password alone will sign you in again.'),
    ).toBeDefined();
    await typeInto(here, 'Your password', 'the right one 123');
    await press(here, 'Continue');
    expect(sent).toEqual(['the right one 123']);
    expect(here.getByRole('status').textContent).toBe('Two-step verification is off.');
    expect(here.getByText('Off')).toBeDefined();
    await expectNoAxeViolations(view.container);
  });

  test('when on: new backup codes take the password, and are shown once without calling it newly on', async () => {
    const view = await open({
      mySignIn: () => Promise.resolve(signIn({ twoFactor: true })),
      newBackupCodes: () => Promise.resolve({ backupCodes: ['fresh-00001', 'fresh-00002'] }),
    });
    const here = card(view);
    await press(here, 'New backup codes…');
    expect(
      here.getByText('Confirm with your password. Your old backup codes stop working.'),
    ).toBeDefined();
    await typeInto(here, 'Your password', 'the right one 123');
    await press(here, 'Continue');
    const shown = within(here.getByRole('region', { name: 'Backup codes' }));
    expect(shown.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'fresh-00001',
      'fresh-00002',
    ]);
    expect(shown.queryByRole('status')).toBeNull();
    await press(here, 'Done');
    expect(here.queryByRole('status')).toBeNull();
    expect(here.getByText('On')).toBeDefined();
  });

  test('a clipboard that refuses is said, and the codes stay on the page', async () => {
    const view = await open({
      mySignIn: () => Promise.resolve(signIn({ twoFactor: true })),
      newBackupCodes: () => Promise.resolve({ backupCodes: ['fresh-00001'] }),
    });
    const here = card(view);
    await press(here, 'New backup codes…');
    await typeInto(here, 'Your password', 'the right one 123');
    await press(here, 'Continue');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error('refused')) },
    });
    // Not through user-event, which puts a clipboard of its own on the page as it clicks.
    fireEvent.click(here.getByRole('button', { name: 'Copy codes' }));
    await settle();
    expect(view.getByText("Couldn't copy. Select the text and copy it yourself.")).toBeDefined();
    expect(here.getByText('fresh-00001')).toBeDefined();
  });

  test.each([
    [
      new LibraryFailure(429, 'RATE_LIMITED', null, 600),
      'Too many attempts. Try again in 10 minutes.',
    ],
    [new LibraryFailure(429, 'MALFORMED'), 'Too many attempts. Try again in 1 minute.'],
    [
      new LibraryFailure(0, 'NETWORK'),
      'Purlay could not be reached. Check your connection and try again.',
    ],
    [
      new LibraryFailure(400, 'TOTP_ALREADY_ENABLED'),
      'That did not finish. Try again in a moment.',
    ],
    [new Error('anything'), 'That did not finish. Try again in a moment.'],
  ])('%s is said in one sentence; Cancel goes back', async (failure, words) => {
    const view = await open({
      mySignIn: () => Promise.resolve(signIn()),
      startTwoFactor: () => Promise.reject(failure),
    });
    const here = card(view);
    await press(here, 'Turn on…');
    await typeInto(here, 'Your password', 'the right one 123');
    await press(here, 'Continue');
    expect(here.getByRole('alert').textContent).toBe(words);
    await press(here, 'Cancel');
    expect(here.queryByLabelText('Your password')).toBeNull();
    expect(here.getByRole('button', { name: 'Turn on…' })).toBeDefined();
  });

  test('says it in Turkish', async () => {
    const view = await open({ mySignIn: () => Promise.resolve(signIn()) }, 'tr');
    const here = within(view.getByRole('region', { name: 'İki adımlı doğrulama' }));
    expect(here.getByText('Kapalı')).toBeDefined();
    await press(here, 'Aç…');
    expect(here.getByText('Sen olduğunu parolanla doğrula.')).toBeDefined();
    expect(here.getByLabelText('Parolan')).toBeDefined();
  });
});
