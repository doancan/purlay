/**
 * The setup wizard (`UX.md` §11, D-179 §4): what each step says, what a failure says in each of its
 * three parts, the reasons that have a sentence in both languages, the address check before a code is
 * sent, the lock's minutes, the finish rule's reason, and that nothing animates under reduced motion
 * and nothing is read on a timer or on window focus.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { act, fireEvent } from '@testing-library/react';
import { PROBE_REASONS, type ProbeResult } from '@purlay/types';
import { en } from '../../i18n/catalogue/en';
import { tr } from '../../i18n/catalogue/tr';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { anApi } from '../../testing/fake-api';
import { aSession } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { SetupFailure } from './client';
import { REASONS } from './errors';
import { ProbeFailure } from './parts';
import { aClient, aState, openSetup, ORIGIN, settle, unheld } from './testing';

installDom();

const catalogue = { en, tr } as const;

/** `window.matchMedia` as a browser that asked for less motion has it. */
const preferReducedMotion = (reduced: boolean): void => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: reduced && query.includes('prefers-reduced-motion'),
      media: query,
      addEventListener: (): void => undefined,
      removeEventListener: (): void => undefined,
    }),
  });
};

afterEach(() => {
  Reflect.deleteProperty(window, 'matchMedia');
});

/** Presses Enter in the one form on the screen. */
const submitForm = (view: { readonly container: HTMLElement }): void => {
  const form = view.container.querySelector('form');
  if (form === null) throw new Error('the screen has no form');
  fireEvent.submit(form);
};

describe('a reason a try can fail for', () => {
  for (const locale of ['en', 'tr'] as const) {
    for (const reason of PROBE_REASONS) {
      test(`${reason} says what happened and how to put it right, in ${locale}`, async () => {
        const words = REASONS[reason];
        const result: ProbeResult = { ok: false, reason, raw: 'the service said no' };
        const view = await renderApp(<ProbeFailure result={result} />, { locale });
        const messages = catalogue[locale];
        expect(view.getByText(messages[words.what])).toBeDefined();
        for (const fix of words.fix) expect(view.getByText(messages[fix])).toBeDefined();
        expect(view.getByText('the service said no')).toBeDefined();
        // A sentence not written would show as its key.
        expect(view.container.textContent).not.toMatch(/setup\.reason\./);
        view.unmount();
      });
    }
  }

  test('shows what the service answered as plain text, never as markup', async () => {
    const raw = '<script>window.hacked = true</script><img src=x onerror="window.hacked = true">';
    const view = await renderApp(
      <ProbeFailure result={{ ok: false, reason: 'unexpected-reply', raw }} />,
    );
    expect(view.container.querySelector('script')).toBeNull();
    expect(view.container.querySelector('img')).toBeNull();
    expect(view.container.querySelector('pre')?.textContent).toBe(raw);
    expect(Reflect.get(window, 'hacked')).toBeUndefined();
  });

  test('does not call GitHub’s `bad_verification_code` a failure: no sentence in either language says it', () => {
    for (const locale of ['en', 'tr'] as const) {
      const all = Object.entries(catalogue[locale])
        .filter(([key]) => key.startsWith('setup.'))
        .map(([, value]) => JSON.stringify(value))
        .join(' ');
      expect(all).not.toMatch(/bad_verification_code/);
      expect(all).not.toMatch(/callback-mismatch/);
    }
  });
});

describe('the setup code', () => {
  const claimAs = async (
    claim: () => Promise<void>,
    locale: 'en' | 'tr' = 'en',
  ): Promise<Awaited<ReturnType<typeof openSetup>>> => {
    const view = await openSetup(aClient({ state: unheld, claim }), { locale });
    const user = person();
    await user.type(
      view.getByRole('textbox', { name: catalogue[locale]['setup.claim.label'] }),
      'ABCD',
    );
    submitForm(view);
    await settle();
    return view;
  };

  test('asks for the code first, and says where the operator reads it', async () => {
    const view = await openSetup(aClient({ state: unheld }));
    expect(view.getByRole('heading', { name: 'Enter the setup code' })).toBeDefined();
    expect(view.getByText('docker compose logs api | grep -i setup')).toBeDefined();
  });

  test('says a wrong code is not the code', async () => {
    const view = await claimAs(() =>
      Promise.reject(new SetupFailure(400, 'VALIDATION_FAILED', 'x', null, { code: 'x' })),
    );
    expect(view.getByText(/That is not the setup code/)).toBeDefined();
  });

  test('says when a lock ends, from Retry-After, in minutes', async () => {
    const view = await claimAs(() =>
      Promise.reject(new SetupFailure(429, 'SETUP_LOCKED', 'x', 900)),
    );
    expect(view.getByText(/Setup opens again in 15 minutes/)).toBeDefined();
    expect(view.getByText(/restarting the server writes a new code/)).toBeDefined();
  });

  test('says when a lock ends in Turkish too', async () => {
    const view = await claimAs(
      () => Promise.reject(new SetupFailure(429, 'SETUP_LOCKED', 'x', 60)),
      'tr',
    );
    expect(view.getByText(/Kurulum 1 dakika sonra yeniden açılır/)).toBeDefined();
  });

  test('says setup is not available when this server is done or held elsewhere', async () => {
    const view = await claimAs(unheld);
    expect(view.getByRole('heading', { name: 'Setup is not available' })).toBeDefined();
    expect(view.getByText(/wait fifteen minutes, restart the server/)).toBeDefined();
  });

  test('takes a right code to the next step', async () => {
    let held = false;
    const view = await openSetup(
      aClient({
        state: () => (held ? Promise.resolve(aState({ steps: ['claim'] })) : unheld()),
        claim: () => {
          held = true;
          return Promise.resolve();
        },
      }),
    );
    const user = person();
    await user.type(view.getByRole('textbox', { name: 'Setup code' }), 'ABCD-EFGH');
    await user.keyboard('{Enter}');
    await settle();
    expect(view.getByRole('heading', { name: 'Create the administrator account' })).toBeDefined();
  });

  test('compares the address before it sends anything, and gives the exact one to use', async () => {
    let claims = 0;
    const view = await openSetup(
      aClient({
        state: unheld,
        claim: () => {
          claims += 1;
          return Promise.resolve();
        },
      }),
      { status: { open: true, appUrl: 'https://chat.example.com' } },
    );
    expect(view.getByText(/You are on a different address/)).toBeDefined();
    expect(view.container.textContent).toContain('https://chat.example.com');
    expect(view.container.textContent).toContain(ORIGIN);
    expect(view.queryByRole('textbox', { name: 'Setup code' })).toBeNull();
    const link = view.getByRole('link', { name: 'Open https://chat.example.com' });
    expect(link.getAttribute('href')).toBe('https://chat.example.com/setup');
    expect(claims).toBe(0);
  });

  test('says a lost claim in the sentence the server’s report gave', async () => {
    let held = true;
    const view = await openSetup(
      aClient({
        state: () => (held ? Promise.resolve(aState({ steps: ['claim'] })) : unheld()),
        admin: () => {
          held = false;
          return Promise.reject(new SetupFailure(404, 'SETUP_UNAVAILABLE', 'x'));
        },
      }),
    );
    const user = person();
    await user.type(view.getByRole('textbox', { name: 'Name' }), 'Ayse Demir');
    await user.type(view.getByRole('textbox', { name: 'Email address' }), 'ayse@example.test');
    await user.type(view.getByLabelText('Password'), 'a long and unusual phrase 7');
    submitForm(view);
    await settle();
    expect(view.getByText(/This setup was started in another browser/)).toBeDefined();
    expect(view.getByRole('heading', { name: 'Enter the setup code' })).toBeDefined();
  });
});

describe('what an assistive technology meets', () => {
  test('has nothing the accessibility audit objects to, on the code, the account and the failed try', async () => {
    const claim = await openSetup(aClient({ state: unheld }));
    await expectNoAxeViolations(claim.container);
    claim.unmount();
    const admin = await openSetup(aClient({ state: () => Promise.resolve(aState()) }));
    await expectNoAxeViolations(admin.container);
    admin.unmount();
    const failed = await renderApp(
      <ProbeFailure result={{ ok: false, reason: 'auth-failed', raw: '535 5.7.8 rejected' }} />,
    );
    await expectNoAxeViolations(failed.container);
  });
});

describe('the server is closed to setup', () => {
  test('says it is set up and offers sign-in, without asking for the state', async () => {
    const view = await openSetup(aClient(), { status: { open: false, appUrl: ORIGIN } });
    expect(view.getByRole('heading', { name: 'This server is set up' })).toBeDefined();
    expect(view.getByRole('link', { name: 'Go to sign in' }).getAttribute('href')).toBe('/sign-in');
  });

  test('offers the app itself to someone already signed in, in both languages', async () => {
    const view = await openSetup(aClient(), {
      status: { open: false, appUrl: ORIGIN },
      api: anApi({
        setupStatus: () => Promise.resolve({ open: false, appUrl: ORIGIN }),
        me: () => Promise.resolve(aSession()),
      }),
    });
    expect(view.getByRole('link', { name: 'Open Purlay' }).getAttribute('href')).toBe('/');
    expect(view.queryByRole('link', { name: 'Go to sign in' })).toBeNull();
    expect(tr['setup.closed.open']).not.toBe(en['setup.closed.open']);
  });
});

describe('the administrator', () => {
  test('shows the password policy as the person types, from the shared rules', async () => {
    const view = await openSetup(aClient({ state: () => Promise.resolve(aState()) }));
    const user = person();
    await user.type(view.getByLabelText('Password'), 'short');
    expect(
      view.getByText('10 to 128 characters, no control characters').parentElement?.textContent,
    ).toContain('not met');
    await user.clear(view.getByLabelText('Password'));
    await user.type(view.getByLabelText('Password'), 'a long and unusual phrase 7');
    expect(
      view.getByText('10 to 128 characters, no control characters').parentElement?.textContent,
    ).toContain('met');
    // The reveal toggle changes the field's type and says so.
    const toggle = view.getByRole('button', { name: 'Show the password' });
    fireEvent.click(toggle);
    expect((view.getByLabelText('Password') as HTMLInputElement).type).toBe('text');
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
  });

  test('says the address is not verified yet, before the button', async () => {
    const view = await openSetup(aClient({ state: () => Promise.resolve(aState()) }));
    expect(view.getByText(/This address is not verified yet/)).toBeDefined();
  });

  test('says which rule a refused password broke, in words', async () => {
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(aState()),
        admin: () =>
          Promise.reject(
            new SetupFailure(400, 'VALIDATION_FAILED', 'x', null, { password: 'common' }),
          ),
      }),
    );
    const user = person();
    await user.type(view.getByRole('textbox', { name: 'Name' }), 'Ayse Demir');
    await user.type(view.getByRole('textbox', { name: 'Email address' }), 'ayse@example.test');
    await user.type(view.getByLabelText('Password'), 'a long and unusual phrase 7');
    submitForm(view);
    await settle();
    expect(view.getByText('That password is one of the commonest.')).toBeDefined();
  });
});

describe('GitHub', () => {
  const atGitHub = aState({ steps: ['claim', 'admin', 'address', 'policy'] });

  const fill = async (view: Awaited<ReturnType<typeof openSetup>>): Promise<void> => {
    const user = person();
    await user.type(view.getByRole('textbox', { name: 'Client ID' }), 'Iv1.abc');
    await user.type(view.getByLabelText('Client secret'), 's3cret');
  };

  test('shows the callback address to paste, and tries before it saves', async () => {
    const calls: boolean[] = [];
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(atGitHub),
        github: ({ save }) => {
          calls.push(save);
          return Promise.resolve({ ok: true });
        },
      }),
    );
    expect(view.getByText(`${ORIGIN}/auth/callback/github`)).toBeDefined();
    await fill(view);
    fireEvent.click(view.getByRole('button', { name: 'Try it' }));
    await settle();
    expect(calls).toEqual([false]);
    expect(view.getByText('GitHub accepted these credentials.')).toBeDefined();
  });

  test('says a refused secret in three parts, and outlines the secret field', async () => {
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(atGitHub),
        github: () =>
          Promise.resolve({
            ok: false,
            reason: 'secret-rejected',
            raw: 'incorrect_client_credentials',
          }),
      }),
    );
    await fill(view);
    fireEvent.click(view.getByRole('button', { name: 'Save and continue' }));
    await settle();
    expect(view.getByText('GitHub knows the app and refused the client secret.')).toBeDefined();
    expect(view.getByText('incorrect_client_credentials')).toBeDefined();
    expect(view.getByLabelText('Client secret').getAttribute('aria-invalid')).toBe('true');
    expect(
      view.getByLabelText('Client secret').closest('div')?.parentElement?.textContent,
    ).not.toContain('bad_verification_code');
    expect(view.getByRole('button', { name: 'Try again' })).toBeDefined();
  });

  test('says what stops working before it is skipped', async () => {
    const view = await openSetup(aClient({ state: () => Promise.resolve(atGitHub) }));
    expect(view.getByText(/If you skip, nobody can sign in with GitHub/)).toBeDefined();
  });
});

describe('email', () => {
  const atEmail = aState({
    steps: ['claim', 'admin', 'address', 'policy', 'github'],
    admin: { name: 'Ayse', email: 'ayse@example.test', emailVerified: false },
  });

  test('says the letter is the test and the verification, and warns before skipping', async () => {
    const view = await openSetup(aClient({ state: () => Promise.resolve(atEmail) }));
    expect(
      view.getByText('We will send a message to ayse@example.test that also verifies it.'),
    ).toBeDefined();
    expect(view.getByText(/If you skip, invitation links are copied, not sent/)).toBeDefined();
  });

  test('lists where a refused message stopped: logged in, then not sent', async () => {
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(atEmail),
        smtp: () => Promise.resolve({ ok: false, reason: 'message-refused', raw: '554 policy' }),
      }),
    );
    const user = person();
    await user.type(view.getByLabelText(/Mail server/), 'smtps://u:p@mail.test:465');
    await user.type(view.getByRole('textbox', { name: /Sender/ }), 'no-reply@example.test');
    fireEvent.click(view.getByRole('button', { name: 'Try the connection and continue' }));
    await settle();
    expect(
      view.getByText('The mail server took both addresses and refused the message.'),
    ).toBeDefined();
    expect(view.getByText('Login accepted').parentElement?.textContent).toContain('done');
    expect(view.getByText('Test message accepted').parentElement?.textContent).toContain('failed');
    expect(view.getByText('554 policy')).toBeDefined();
  });

  test('says the message went, and that opening its link verifies the address', async () => {
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(atEmail),
        smtp: () => Promise.resolve({ ok: true }),
      }),
    );
    const user = person();
    await user.type(view.getByLabelText(/Mail server/), 'smtps://u:p@mail.test:465');
    await user.type(view.getByRole('textbox', { name: /Sender/ }), 'no-reply@example.test');
    fireEvent.click(view.getByRole('button', { name: 'Try the connection and continue' }));
    await settle();
    expect(
      view.getByText(
        'We sent a message to ayse@example.test. Open the link in it to verify your address.',
      ),
    ).toBeDefined();
  });

  test('moves focus to the heading when the try is taken, and masks the address that carries the password', async () => {
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(atEmail),
        smtp: () => Promise.resolve({ ok: true }),
      }),
    );
    const user = person();
    const address = view.getByLabelText(/Mail server/);
    expect(address.getAttribute('type')).toBe('password');
    fireEvent.click(view.getByRole('button', { name: 'Show the mail server address' }));
    expect(address.getAttribute('type')).toBe('text');
    await user.type(address, 'smtps://u:p@mail.test:465');
    await user.type(view.getByRole('textbox', { name: /Sender/ }), 'no-reply@example.test');
    fireEvent.click(view.getByRole('button', { name: 'Try the connection and continue' }));
    await settle();
    expect(document.activeElement?.tagName).toBe('H1');
  });
});

describe('finishing', () => {
  const atFinish = (over: Parameters<typeof aState>[0] = {}): ReturnType<typeof aState> =>
    aState({
      steps: ['claim', 'admin', 'address', 'policy', 'github', 'email', 'workspace', 'invite'],
      admin: { name: 'Ayse', email: 'ayse@example.test', emailVerified: false },
      workspace: { id: 'w1', name: 'Acme', slug: 'acme' },
      ...over,
    });

  test('keeps Finish disabled until a channel is connected, and says why', async () => {
    const view = await openSetup(
      aClient({
        state: () =>
          Promise.resolve(atFinish({ canFinish: false, finishProblems: ['no-channel'] })),
      }),
    );
    const finish = view.getByRole('button', { name: 'Finish setup' }) as HTMLButtonElement;
    expect(finish.disabled).toBe(true);
    expect(
      view.getByText(/Nobody else could sign in\. If you finished now, only you could/),
    ).toBeDefined();
    expect(view.getByRole('button', { name: 'Back to GitHub' })).toBeDefined();
    expect(view.getByRole('button', { name: 'Back to email' })).toBeDefined();
  });

  test('goes back to the screen that connects a way in', async () => {
    const view = await openSetup(
      aClient({
        state: () =>
          Promise.resolve(atFinish({ canFinish: false, finishProblems: ['no-channel'] })),
      }),
    );
    fireEvent.click(view.getByRole('button', { name: 'Back to GitHub' }));
    await settle();
    expect(view.getByRole('heading', { name: 'Sign in with GitHub' })).toBeDefined();
  });

  test('finishes into the workspace when the rule holds', async () => {
    let finished = 0;
    const view = await openSetup(
      aClient({
        state: () =>
          Promise.resolve(
            atFinish({
              canFinish: true,
              finishProblems: [],
              channels: { github: true, email: false },
            }),
          ),
        finish: () => {
          finished += 1;
          return Promise.resolve();
        },
      }),
    );
    const finish = view.getByRole('button', { name: 'Finish setup' }) as HTMLButtonElement;
    expect(finish.disabled).toBe(false);
    fireEvent.click(finish);
    await settle();
    expect(finished).toBe(1);
    expect(view.world.history.stack.at(-1)).toBe('/w/acme');
  });
});

describe('resuming', () => {
  test('comes back to the first screen the server has not passed', async () => {
    const view = await openSetup(
      aClient({
        state: () =>
          Promise.resolve(
            aState({
              steps: ['claim', 'admin'],
              admin: { name: 'Ayse', email: 'ayse@example.test', emailVerified: false },
            }),
          ),
      }),
    );
    expect(view.getByRole('heading', { name: 'Confirm the server address' })).toBeDefined();
    expect(view.getByText('Step 3 of 8')).toBeDefined();
    const nav = view.getByRole('navigation', { name: 'Setup steps' });
    expect(nav.querySelector('[aria-current="step"]')?.textContent).toContain('Server address');
  });

  test('names every screen in the list, in both languages', async () => {
    for (const locale of ['en', 'tr'] as const) {
      const view = await openSetup(aClient({ state: () => Promise.resolve(aState()) }), { locale });
      const items = view
        .getByRole('navigation', { name: catalogue[locale]['setup.stepper.label'] })
        .querySelectorAll('li');
      expect(items.length).toBe(8);
      view.unmount();
    }
  });
});

describe('what the wizard asks of the server', () => {
  test('reads the status once and the state once, never on a timer or on focus', async () => {
    let statuses = 0;
    let states = 0;
    const view = await openSetup(
      aClient({
        state: () => {
          states += 1;
          return Promise.resolve(aState());
        },
      }),
      {
        onStatus: () => {
          statuses += 1;
        },
      },
    );
    await act(async () => {
      window.dispatchEvent(new window.Event('focus'));
      window.dispatchEvent(new window.Event('visibilitychange'));
      window.dispatchEvent(new window.Event('online'));
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    await settle();
    expect(statuses).toBe(1);
    expect(states).toBe(1);
    view.unmount();
  });
});

describe('motion', () => {
  test('moves a step in, and the mark settles, where motion is allowed', async () => {
    preferReducedMotion(false);
    const view = await openSetup(aClient({ state: () => Promise.resolve(aState()) }));
    expect(view.container.querySelector('.animate-step-in')).not.toBeNull();
  });

  test('plays no motion under reduced motion', async () => {
    preferReducedMotion(true);
    const view = await openSetup(
      aClient({
        state: () =>
          Promise.resolve(
            aState({
              steps: ['claim', 'admin', 'address', 'policy'],
              admin: { name: 'Ayse', email: 'ayse@example.test', emailVerified: false },
            }),
          ),
        github: () =>
          Promise.resolve({
            ok: false,
            reason: 'secret-rejected',
            raw: 'incorrect_client_credentials',
          }),
      }),
    );
    const user = person();
    await user.type(view.getByRole('textbox', { name: 'Client ID' }), 'Iv1.abc');
    await user.type(view.getByLabelText('Client secret'), 's3cret');
    fireEvent.click(view.getByRole('button', { name: 'Save and continue' }));
    await settle();
    expect(view.getByText('GitHub knows the app and refused the client secret.')).toBeDefined();
    expect(view.container.querySelector('[class*="animate-"]')).toBeNull();
  });
});
