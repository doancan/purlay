/**
 * The two ways in and the last screen (UX §11): GitHub and email each try before they keep, say a
 * refused try where it belongs, can be skipped and can be done again; Finish names what is missing and
 * where to go for it, and a failure to finish is said and the claim's loss is followed.
 */
import { describe, expect, test } from 'bun:test';
import type { ProbeResult, SetupState } from '@purlay/types';
import { en } from '../../i18n/catalogue/en';
import { tr } from '../../i18n/catalogue/tr';
import { installDom } from '../../testing/dom';
import { person } from '../../testing/user';
import { SetupFailure, type SetupClient } from './client';
import { aClient, aState, openSetup, settle, unheld } from './testing';

installDom();

type View = Awaited<ReturnType<typeof openSetup>>;

const ADMIN = { name: 'Ayse', email: 'ayse@example.test', emailVerified: false };
const atGithub = (over: Partial<SetupState> = {}): SetupState =>
  aState({ steps: ['claim', 'admin', 'address', 'policy'], admin: ADMIN, ...over });
const atEmail = (over: Partial<SetupState> = {}): SetupState =>
  atGithub({ steps: ['claim', 'admin', 'address', 'policy', 'github'], ...over });
const atFinish = (over: Partial<SetupState> = {}): SetupState =>
  aState({
    steps: ['claim', 'admin', 'address', 'policy', 'github', 'email', 'workspace', 'invite'],
    admin: ADMIN,
    workspace: { id: 'w1', name: 'Acme', slug: 'acme' },
    ...over,
  });

const CONNECTED_GITHUB = { clientId: 'Iv1.abc', clientSecret: { set: true } } as const;
const CONNECTED_SMTP = {
  address: { set: true, host: 'smtp://mail.example.test:587' },
  from: 'purlay@example.test',
  allowPlaintext: true,
} as const;

const press = async (view: View, name: string | RegExp): Promise<void> => {
  await person().click(view.getByRole('button', { name }));
  await settle();
};

/** A client whose one `method` finds the claim gone, after which the state is no longer held. */
const losing = (
  state: SetupState,
  method: 'github' | 'smtp' | 'skipGithub' | 'skipSmtp' | 'finish',
): SetupClient => {
  let held = true;
  return aClient({
    state: () => (held ? Promise.resolve(state) : unheld()),
    [method]: () => {
      held = false;
      return Promise.reject(new SetupFailure(404, 'SETUP_UNAVAILABLE', 'gone'));
    },
  });
};

describe('GitHub', () => {
  const fillGithub = async (view: View): Promise<void> => {
    await person().type(view.getByLabelText('Client ID'), ' Iv1.abc ');
    await person().type(view.getByLabelText('Client secret'), ' shh ');
  };

  test('keeps the buttons off until both fields are filled', async () => {
    const view = await openSetup(aClient({ state: () => Promise.resolve(atGithub()) }));
    const tryIt = view.getByRole('button', { name: 'Try it' }) as HTMLButtonElement;
    expect(tryIt.disabled).toBe(true);
    await person().type(view.getByLabelText('Client ID'), 'id');
    expect(tryIt.disabled).toBe(true);
    await person().type(view.getByLabelText('Client secret'), 'secret');
    expect(tryIt.disabled).toBe(false);
  });

  test('tries without keeping: sends save false, says GitHub accepted it, and moves on only when saved', async () => {
    const sent: unknown[] = [];
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(atGithub()),
        github: (input) => {
          sent.push(input);
          return Promise.resolve({ ok: true });
        },
      }),
    );
    await fillGithub(view);
    await press(view, 'Try it');
    expect(sent).toEqual([{ clientId: 'Iv1.abc', clientSecret: 'shh', save: false }]);
    expect(view.getByText(en['setup.github.ok'])).toBeDefined();
    expect(view.getByRole('heading', { name: 'Sign in with GitHub' })).toBeDefined();
    // Editing a field takes the verdict away: it no longer describes what is typed.
    await person().type(view.getByLabelText('Client ID'), 'x');
    expect(view.queryByText(en['setup.github.ok'])).toBeNull();
  });

  test('saves with Enter, sends save true, and shows the next screen from the new state', async () => {
    const sent: unknown[] = [];
    let state = atGithub();
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(state),
        github: (input) => {
          sent.push(input);
          state = atEmail({ settings: { ...aState().settings, github: CONNECTED_GITHUB } });
          return Promise.resolve({ ok: true });
        },
      }),
    );
    await fillGithub(view);
    await person().type(view.getByLabelText('Client secret'), '{Enter}');
    await settle();
    expect(sent).toEqual([{ clientId: 'Iv1.abc', clientSecret: 'shh', save: true }]);
    expect(view.getByRole('heading', { name: 'Connect email' })).toBeDefined();
  });

  test('does not submit an empty form with Enter', async () => {
    let sent = 0;
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(atGithub()),
        github: () => {
          sent += 1;
          return Promise.resolve({ ok: true });
        },
      }),
    );
    await person().type(view.getByLabelText('Client ID'), 'id{Enter}');
    expect(sent).toBe(0);
  });

  test('says a refused try, outlines the field it names, and offers Try again', async () => {
    const refused: ProbeResult = { ok: false, reason: 'unexpected-reply', raw: 'nope' };
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(atGithub()),
        github: () => Promise.resolve(refused),
      }),
    );
    await fillGithub(view);
    await press(view, 'Save and continue');
    expect(view.getByText('nope')).toBeDefined();
    expect(view.getByRole('button', { name: 'Try again' })).toBeDefined();
    // One primary action after a refusal: no second "Try it" beside it, and no "Save and continue".
    expect(view.queryByRole('button', { name: 'Try it' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Save and continue' })).toBeNull();
  });

  test('says a call that failed outright, and follows the claim being lost', async () => {
    const failing = await openSetup(
      aClient({
        state: () => Promise.resolve(atGithub()),
        github: () => Promise.reject(new SetupFailure(0, 'NETWORK', 'down')),
      }),
    );
    await fillGithub(failing);
    await press(failing, 'Try it');
    expect(failing.getByRole('alert').textContent).toContain(en['setup.failed.network']);
    failing.unmount();

    const lost = await openSetup(losing(atGithub(), 'github'));
    await fillGithub(lost);
    await press(lost, 'Try it');
    expect(lost.getByRole('heading', { name: /code/i })).toBeDefined();
  });

  test('skips, and says so to the server before showing the next screen', async () => {
    let skipped = 0;
    let state = atGithub();
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(state),
        skipGithub: () => {
          skipped += 1;
          state = atEmail();
          return Promise.resolve();
        },
      }),
    );
    await press(view, 'Skip for now');
    expect(skipped).toBe(1);
    expect(view.getByRole('heading', { name: 'Connect email' })).toBeDefined();
  });

  test('says a failed skip, and follows the claim being lost', async () => {
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(atGithub()),
        skipGithub: () => Promise.reject(new SetupFailure(0, 'NETWORK', 'down')),
      }),
    );
    await press(view, 'Skip for now');
    expect(view.getByRole('alert').textContent).toContain(en['setup.failed.network']);
    view.unmount();
    const lost = await openSetup(losing(atGithub(), 'skipGithub'));
    await press(lost, 'Skip for now');
    expect(lost.getByRole('heading', { name: /code/i })).toBeDefined();
  });

  test('when connected, says so without the secret, and can be done again or gone on from', async () => {
    let state = atGithub({
      settings: { ...aState().settings, github: CONNECTED_GITHUB },
      channels: { github: true, email: false },
    });
    const view = await openSetup(aClient({ state: () => Promise.resolve(state) }));
    expect(view.getByText(en['setup.github.connected'])).toBeDefined();
    expect(view.container.textContent).not.toContain('shh');
    await press(view, 'Try again');
    expect((view.getByLabelText('Client ID') as HTMLInputElement).value).toBe('Iv1.abc');
    expect((view.getByLabelText('Client secret') as HTMLInputElement).value).toBe('');
    state = atEmail({ settings: { ...aState().settings, github: CONNECTED_GITHUB } });
  });

  test('a secret that can no longer be read asks for it again instead of showing connected', async () => {
    const view = await openSetup(
      aClient({
        state: () =>
          Promise.resolve(
            atGithub({
              settings: { ...aState().settings, github: CONNECTED_GITHUB },
              needsReentry: ['github'],
            }),
          ),
      }),
    );
    expect(view.getByText(en['setup.github.reentry'])).toBeDefined();
    expect(view.queryByText(en['setup.github.connected'])).toBeNull();
  });

  test('an app that is only in the settings (the environment put it there) is not called connected, and Continue passes the step without a try', async () => {
    let state = atGithub({ settings: { ...aState().settings, github: CONNECTED_GITHUB } });
    let skipped = 0;
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(state),
        skipGithub: () => {
          skipped += 1;
          state = atEmail({ settings: { ...aState().settings, github: CONNECTED_GITHUB } });
          return Promise.resolve();
        },
      }),
    );
    expect(view.getByText(en['setup.github.untried'])).toBeDefined();
    expect(view.queryByText(en['setup.github.connected']) === null).toBe(true);
    await press(view, 'Continue');
    // The step is passed — not "read again" and left where it was.
    expect(skipped).toBe(1);
    expect(view.getByRole('heading', { name: 'Connect email' })).toBeDefined();
  });

  test('Continue on that screen says a failure, and follows the claim being lost', async () => {
    const seeded = atGithub({ settings: { ...aState().settings, github: CONNECTED_GITHUB } });
    const failing = await openSetup(
      aClient({
        state: () => Promise.resolve(seeded),
        skipGithub: () => Promise.reject(new SetupFailure(0, 'NETWORK', 'down')),
      }),
    );
    await press(failing, 'Continue');
    expect(failing.getByRole('alert').textContent).toContain(en['setup.failed.network']);
    failing.unmount();
    const lost = await openSetup(losing(seeded, 'skipGithub'));
    await press(lost, 'Continue');
    expect(lost.getByRole('heading', { name: /code/i })).toBeDefined();
  });

  test('Continue on a connected screen that was passed goes to the next without a call', async () => {
    const view = await openSetup(
      aClient({
        state: () =>
          Promise.resolve(
            atEmail({
              settings: { ...aState().settings, github: CONNECTED_GITHUB },
              channels: { github: true, email: false },
            }),
          ),
      }),
    );
    await press(view, 'Back');
    expect(view.getByText(en['setup.github.connected'])).toBeDefined();
    await press(view, 'Continue');
    expect(view.getByRole('heading', { name: 'Connect email' })).toBeDefined();
  });

  test('walked back to after it was passed untried, it still says untried, and Continue asks for nothing', async () => {
    const view = await openSetup(
      aClient({
        state: () =>
          Promise.resolve(
            atEmail({ settings: { ...aState().settings, github: CONNECTED_GITHUB } }),
          ),
      }),
    );
    await press(view, 'Back');
    expect(view.getByText(en['setup.github.untried'])).toBeDefined();
    await press(view, 'Continue');
    expect(view.getByRole('heading', { name: 'Connect email' })).toBeDefined();
  });
});

describe('email', () => {
  const fillMail = async (view: View): Promise<void> => {
    await person().type(view.getByLabelText('Mail server'), ' smtp://mail.example.test ');
    await person().type(view.getByLabelText('Sender'), ' purlay@example.test ');
  };
  const TRY = 'Try the connection and continue';

  test('says which letter will be sent, by whether the address is verified', async () => {
    const unverified = await openSetup(aClient({ state: () => Promise.resolve(atEmail()) }));
    expect(
      unverified.getByText('We will send a message to ayse@example.test that also verifies it.'),
    ).toBeDefined();
    unverified.unmount();
    const verified = await openSetup(
      aClient({
        state: () => Promise.resolve(atEmail({ admin: { ...ADMIN, emailVerified: true } })),
      }),
    );
    expect(verified.getByText('We will send a test message to ayse@example.test.')).toBeDefined();
  });

  test('sends the address, the sender, the plaintext choice and the language, and keeps it', async () => {
    const sent: unknown[] = [];
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(atEmail()),
        smtp: (input) => {
          sent.push(input);
          return Promise.resolve({ ok: true });
        },
      }),
    );
    await fillMail(view);
    await person().click(view.getByRole('checkbox', { name: /Allow an unencrypted connection/ }));
    await press(view, TRY);
    expect(sent).toEqual([
      {
        smtpUrl: 'smtp://mail.example.test',
        from: 'purlay@example.test',
        allowPlaintext: true,
        locale: 'en',
        save: true,
      },
    ]);
  });

  test('sends the language of the screen', async () => {
    const sent: { locale: string }[] = [];
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(atEmail()),
        smtp: (input) => {
          sent.push(input);
          return Promise.resolve({ ok: true });
        },
      }),
      { locale: 'tr' },
    );
    await person().type(view.getByLabelText(tr['setup.email.url']), 'smtp://m.example.test');
    await person().type(view.getByLabelText(tr['setup.email.from']), 'a@example.test');
    await person().click(view.getByRole('button', { name: tr['setup.email.try'] }));
    await settle();
    expect(sent.map((one) => one.locale)).toEqual(['tr']);
  });

  test('says the message went, with the four stages done, and goes on only when told to', async () => {
    let state = atEmail();
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(state),
        smtp: () => {
          state = atEmail({
            steps: ['claim', 'admin', 'address', 'policy', 'github', 'email'],
            settings: { ...aState().settings, smtp: CONNECTED_SMTP },
          });
          return Promise.resolve({ ok: true });
        },
      }),
    );
    await fillMail(view);
    await press(view, TRY);
    expect(
      view.getByText(en['setup.email.sent'].replace('{email}', 'ayse@example.test')),
    ).toBeDefined();
    expect(view.getAllByText(en['setup.email.stage.done']).length).toBeGreaterThan(0);
    expect(view.queryByRole('heading', { name: 'Create the first workspace' })).toBeNull();
    await press(view, 'Continue');
    expect(view.getByRole('heading', { name: 'Create the first workspace' })).toBeDefined();
  });

  test('says a verified address got a test message, not a verification', async () => {
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(atEmail({ admin: { ...ADMIN, emailVerified: true } })),
        smtp: () => Promise.resolve({ ok: true }),
      }),
    );
    await fillMail(view);
    await press(view, TRY);
    expect(view.getByText('We sent a test message to ayse@example.test.')).toBeDefined();
  });

  test('says where a refused try stopped, outlines the field it names, and offers Try again', async () => {
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(atEmail()),
        smtp: () => Promise.resolve({ ok: false, reason: 'auth-failed', raw: '535 denied' }),
      }),
    );
    await fillMail(view);
    await press(view, TRY);
    expect(view.getByText('535 denied')).toBeDefined();
    expect(view.getByText(en['setup.email.stage.failed'])).toBeDefined();
    expect(view.getByRole('button', { name: 'Try again' })).toBeDefined();
    await person().type(view.getByLabelText('Sender'), 'x');
    expect(view.queryByText('535 denied')).toBeNull();
  });

  test('says a call that failed outright, and follows the claim being lost', async () => {
    const failing = await openSetup(
      aClient({
        state: () => Promise.resolve(atEmail()),
        smtp: () => Promise.reject(new SetupFailure(0, 'NETWORK', 'down')),
      }),
    );
    await fillMail(failing);
    await press(failing, TRY);
    expect(failing.getByRole('alert').textContent).toContain(en['setup.failed.network']);
    failing.unmount();
    const lost = await openSetup(losing(atEmail(), 'smtp'));
    await fillMail(lost);
    await press(lost, TRY);
    expect(lost.getByRole('heading', { name: /code/i })).toBeDefined();
  });

  test('does not submit an empty form with Enter', async () => {
    let sent = 0;
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(atEmail()),
        smtp: () => {
          sent += 1;
          return Promise.resolve({ ok: true });
        },
      }),
    );
    await person().type(view.getByLabelText('Sender'), 'a@example.test{Enter}');
    expect(sent).toBe(0);
  });

  test('skips, and says a failed skip, and follows the claim being lost', async () => {
    let skipped = 0;
    let state = atEmail();
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(state),
        skipSmtp: () => {
          skipped += 1;
          state = atEmail({ steps: ['claim', 'admin', 'address', 'policy', 'github', 'email'] });
          return Promise.resolve();
        },
      }),
    );
    await press(view, 'Skip for now');
    expect(skipped).toBe(1);
    expect(view.getByRole('heading', { name: 'Create the first workspace' })).toBeDefined();
    view.unmount();

    const failing = await openSetup(
      aClient({
        state: () => Promise.resolve(atEmail()),
        skipSmtp: () => Promise.reject(new SetupFailure(0, 'NETWORK', 'down')),
      }),
    );
    await press(failing, 'Skip for now');
    expect(failing.getByRole('alert').textContent).toContain(en['setup.failed.network']);
    failing.unmount();
    const lost = await openSetup(losing(atEmail(), 'skipSmtp'));
    await press(lost, 'Skip for now');
    expect(lost.getByRole('heading', { name: /code/i })).toBeDefined();
  });

  test('when connected, says so, can be tried again with the sender kept, or gone on from', async () => {
    const view = await openSetup(
      aClient({
        state: () =>
          Promise.resolve(
            atEmail({
              steps: ['claim', 'admin', 'address', 'policy', 'github', 'email'],
              settings: { ...aState().settings, smtp: CONNECTED_SMTP },
              channels: { github: false, email: true },
            }),
          ),
      }),
    );
    await press(view, 'Back');
    expect(view.getByText(en['setup.email.connected'])).toBeDefined();
    await press(view, 'Try again');
    expect((view.getByLabelText('Sender') as HTMLInputElement).value).toBe('purlay@example.test');
    expect((view.getByRole('checkbox') as HTMLInputElement).checked).toBe(true);
    expect((view.getByLabelText('Mail server') as HTMLInputElement).value).toBe('');
  });

  test('a relay that is only in the settings is not called connected, and Continue passes the step without a try; once passed, Continue goes on with no call', async () => {
    let state = atEmail({ settings: { ...aState().settings, smtp: CONNECTED_SMTP } });
    let skipped = 0;
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(state),
        skipSmtp: () => {
          skipped += 1;
          state = { ...state, steps: [...state.steps, 'email'] };
          return Promise.resolve();
        },
      }),
    );
    expect(view.getByText(en['setup.email.untried'])).toBeDefined();
    expect(view.queryByText(en['setup.email.connected']) === null).toBe(true);
    await press(view, 'Continue');
    expect(skipped).toBe(1);
    expect(view.getByRole('heading', { name: 'Create the first workspace' })).toBeDefined();
    // Walked back to, it is passed already: Continue goes on and asks for nothing.
    await press(view, 'Back');
    await press(view, 'Continue');
    expect(skipped).toBe(1);
    expect(view.getByRole('heading', { name: 'Create the first workspace' })).toBeDefined();
  });

  test('Continue on that screen says a failure, and follows the claim being lost', async () => {
    const seeded = atEmail({ settings: { ...aState().settings, smtp: CONNECTED_SMTP } });
    const failing = await openSetup(
      aClient({
        state: () => Promise.resolve(seeded),
        skipSmtp: () => Promise.reject(new SetupFailure(0, 'NETWORK', 'down')),
      }),
    );
    await press(failing, 'Continue');
    expect(failing.getByRole('alert').textContent).toContain(en['setup.failed.network']);
    failing.unmount();
    const lost = await openSetup(losing(seeded, 'skipSmtp'));
    await press(lost, 'Continue');
    expect(lost.getByRole('heading', { name: /code/i })).toBeDefined();
  });

  test('a mail login that can no longer be read asks for it again', async () => {
    const view = await openSetup(
      aClient({
        state: () =>
          Promise.resolve(
            atEmail({
              settings: { ...aState().settings, smtp: CONNECTED_SMTP },
              needsReentry: ['smtp'],
            }),
          ),
      }),
    );
    expect(view.getByText(en['setup.email.reentry'])).toBeDefined();
    expect(view.queryByText(en['setup.email.connected']) === null).toBe(true);
  });
});

describe('email: the letter again', () => {
  const TRY = 'Try the connection and continue';
  // Kept after a try that worked: the relay is tried and serving, which is what a letter again is offered on.
  const KEPT = atEmail({
    steps: ['claim', 'admin', 'address', 'policy', 'github', 'email'],
    settings: { ...aState().settings, smtp: CONNECTED_SMTP },
    channels: { github: false, email: true },
  });
  const AGAIN = en['setup.email.resend'];

  /** The connected screen, which a person comes back to when the letter never came. */
  const connected = async (
    over: Partial<SetupClient>,
    state: SetupState = KEPT,
    options: Parameters<typeof openSetup>[1] = {},
  ): Promise<View> => {
    const view = await openSetup(
      aClient({ state: () => Promise.resolve(state), ...over }),
      options,
    );
    await press(view, 'Back');
    return view;
  };

  test('is offered on the connected screen with the address it goes to, and sends in the screen’s language', async () => {
    const sent: string[] = [];
    const view = await connected({
      resendSmtp: (locale) => {
        sent.push(locale);
        return Promise.resolve({ ok: true });
      },
    });
    expect(view.getByText(en['setup.email.connected'])).toBeDefined();
    await press(view, AGAIN);
    expect(sent).toEqual(['en']);
    expect(
      view.getByText(en['setup.email.resent'].replace('{email}', 'ayse@example.test')),
    ).toBeDefined();
    // Still there: a second letter is asked for the same way.
    await press(view, AGAIN);
    expect(sent).toEqual(['en', 'en']);
  });

  test('asks in Turkish on a Turkish screen', async () => {
    const sent: string[] = [];
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(KEPT),
        resendSmtp: (locale) => {
          sent.push(locale);
          return Promise.resolve({ ok: true });
        },
      }),
      { locale: 'tr' },
    );
    await person().click(view.getByRole('button', { name: tr['setup.back'] }));
    await settle();
    await person().click(view.getByRole('button', { name: tr['setup.email.resend'] }));
    await settle();
    expect(sent).toEqual(['tr']);
  });

  test('is a test message again, not a letter, once the address is verified', async () => {
    const view = await connected(
      { resendSmtp: () => Promise.resolve({ ok: true }) },
      { ...KEPT, admin: { ...ADMIN, emailVerified: true } },
    );
    expect(view.queryByRole('button', { name: AGAIN }) === null).toBe(true);
    await press(view, en['setup.email.resendTest']);
    expect(
      view.getByText(en['setup.email.resentTest'].replace('{email}', 'ayse@example.test')),
    ).toBeDefined();
  });

  test('says where a relay that refuses now stopped, with its words, and can be asked again', async () => {
    let asked = 0;
    const view = await connected({
      resendSmtp: () => {
        asked += 1;
        return Promise.resolve({ ok: false, reason: 'auth-failed', raw: '535 denied' });
      },
    });
    await press(view, AGAIN);
    expect(view.getByText('535 denied')).toBeDefined();
    expect(view.getByText(en['setup.email.stage.failed'])).toBeDefined();
    expect(
      view.queryByText(en['setup.email.resent'].replace('{email}', 'ayse@example.test')),
    ).toBeNull();
    await press(view, AGAIN);
    expect(asked).toBe(2);
  });

  test('says a call that failed outright, and follows the claim being lost', async () => {
    const failing = await connected({
      resendSmtp: () => Promise.reject(new SetupFailure(0, 'NETWORK', 'down')),
    });
    await press(failing, AGAIN);
    expect(failing.getByRole('alert').textContent).toContain(en['setup.failed.network']);
    failing.unmount();
    let held = true;
    const lost = await connected({
      state: () => (held ? Promise.resolve(KEPT) : unheld()),
      resendSmtp: () => {
        held = false;
        return Promise.reject(new SetupFailure(404, 'SETUP_UNAVAILABLE', 'gone'));
      },
    });
    await press(lost, AGAIN);
    expect(lost.getByRole('heading', { name: /code/i })).toBeDefined();
  });

  test('a refusal of the order is said, and the button is usable again', async () => {
    const view = await connected({
      resendSmtp: () =>
        Promise.reject(
          new SetupFailure(409, 'SETUP_STEP_REFUSED', 'later', null, {}, 'out-of-order'),
        ),
    });
    await press(view, AGAIN);
    expect(view.getByRole('alert').textContent).toContain(en['setup.failed.order']);
    expect(view.getByRole('button', { name: AGAIN }).hasAttribute('disabled')).toBe(false);
  });

  test('after a send, says the kind of letter the state now shows: a link followed meanwhile makes it a test message', async () => {
    let state = KEPT;
    const view = await connected(
      {
        state: () => Promise.resolve(state),
        resendSmtp: () => {
          // The administrator followed the first link in another tab before this press was answered.
          state = { ...KEPT, admin: { ...ADMIN, emailVerified: true } };
          return Promise.resolve({ ok: true });
        },
      },
      KEPT,
    );
    await press(view, AGAIN);
    expect(
      view.getByText(en['setup.email.resentTest'].replace('{email}', 'ayse@example.test')),
    ).toBeDefined();
    expect(
      view.queryByText(en['setup.email.resent'].replace('{email}', 'ayse@example.test')) === null,
    ).toBe(true);
  });

  test('says the letter went when reading the state afterwards fails, as far as the screen last knew', async () => {
    let reads = 0;
    const view = await connected({
      state: () => {
        reads += 1;
        // The first read draws the wizard; the one after the send is the one that fails.
        return reads === 1
          ? Promise.resolve(KEPT)
          : Promise.reject(new SetupFailure(0, 'NETWORK', 'down'));
      },
      resendSmtp: () => Promise.resolve({ ok: true }),
    });
    await press(view, AGAIN);
    expect(
      view.getByText(en['setup.email.resent'].replace('{email}', 'ayse@example.test')),
    ).toBeDefined();
    // The send was not undone by it: no failure is said.
    expect(view.queryByText(en['setup.failed.network']) === null).toBe(true);
  });

  test('takes the last "sent" note away while the next send is on its way', async () => {
    let release: () => void = () => undefined;
    let calls = 0;
    const view = await connected({
      resendSmtp: () => {
        calls += 1;
        if (calls === 1) return Promise.resolve({ ok: true });
        return new Promise((resolve) => {
          release = (): void => {
            resolve({ ok: true });
          };
        });
      },
    });
    const note = en['setup.email.resent'].replace('{email}', 'ayse@example.test');
    await press(view, AGAIN);
    expect(view.getByText(note)).toBeDefined();
    await person().click(view.getByRole('button', { name: AGAIN }));
    expect(view.queryByText(note) === null).toBe(true);
    release();
    await settle();
    expect(view.getByText(note)).toBeDefined();
  });

  test('a double press is one letter: the button is held while the first is on its way', async () => {
    let release: () => void = () => undefined;
    let calls = 0;
    const view = await connected({
      resendSmtp: () => {
        calls += 1;
        return new Promise((resolve) => {
          release = (): void => {
            resolve({ ok: true });
          };
        });
      },
    });
    const button = view.getByRole('button', { name: AGAIN });
    await person().click(button);
    await person().click(button);
    expect(calls).toBe(1);
    release();
    await settle();
    expect(calls).toBe(1);
  });

  test('says, with a refusal, where to change what cannot be changed here', async () => {
    const view = await connected({
      resendSmtp: () => Promise.resolve({ ok: false, reason: 'auth-failed', raw: '535 denied' }),
    });
    await press(view, AGAIN);
    expect(view.getByText(en['setup.email.resendFix'])).toBeDefined();
  });

  test('a saved relay the server can no longer try says so, and where to enter it again', async () => {
    const view = await connected({
      resendSmtp: () =>
        Promise.reject(
          new SetupFailure(400, 'VALIDATION_FAILED', 'That cannot be tried.', null, {
            from: 'one plain address, with no name and nothing else',
          }),
        ),
    });
    await press(view, AGAIN);
    expect(view.getByText(en['setup.email.resendSavedInvalid'])).toBeDefined();
    expect(view.queryByText(en['setup.failed.generic']) === null).toBe(true);
  });

  test('is offered right after a try that worked too, where the person waits for the message', async () => {
    const sent: string[] = [];
    let state = atEmail();
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(state),
        smtp: () => {
          state = KEPT;
          return Promise.resolve({ ok: true });
        },
        resendSmtp: (locale) => {
          sent.push(locale);
          return Promise.resolve({ ok: true });
        },
      }),
    );
    await person().type(view.getByLabelText('Mail server'), 'smtp://mail.example.test');
    await person().type(view.getByLabelText('Sender'), 'purlay@example.test');
    await press(view, TRY);
    expect(
      view.getByText(en['setup.email.sent'].replace('{email}', 'ayse@example.test')),
    ).toBeDefined();
    await press(view, AGAIN);
    expect(sent).toEqual(['en']);
    // The server's state says the mail step has passed; the wizard does not move on under the person
    // who is waiting for the message: that is Continue's to do.
    expect(view.getByRole('heading', { name: 'Connect email' })).toBeDefined();
    expect(
      view.getByText(en['setup.email.resent'].replace('{email}', 'ayse@example.test')),
    ).toBeDefined();
    expect(view.queryByRole('heading', { name: 'Create the first workspace' }) === null).toBe(true);
  });

  test('is not offered where there is no relay to send through', async () => {
    const view = await openSetup(aClient({ state: () => Promise.resolve(atEmail()) }));
    expect(view.queryByRole('button', { name: AGAIN }) === null).toBe(true);
    view.unmount();
    const reentry = await openSetup(
      aClient({
        state: () =>
          Promise.resolve(
            atEmail({
              settings: { ...aState().settings, smtp: CONNECTED_SMTP },
              needsReentry: ['smtp'],
            }),
          ),
      }),
    );
    expect(reentry.queryByRole('button', { name: AGAIN }) === null).toBe(true);
  });
});

describe('finishing', () => {
  test('names a missing workspace and a missing way in, each with where to go', async () => {
    const view = await openSetup(
      aClient({
        state: () =>
          Promise.resolve(
            atFinish({
              workspace: null,
              canFinish: false,
              finishProblems: ['no-workspace', 'no-channel'],
            }),
          ),
      }),
    );
    expect(view.getByText(en['setup.finish.problem.no-workspace'])).toBeDefined();
    expect(view.getByText(en['setup.finish.problem.no-channel'])).toBeDefined();
    await press(view, 'Back to email');
    expect(view.getByRole('heading', { name: 'Connect email' })).toBeDefined();
  });

  test('finishes into the home screen when there is no workspace to go to', async () => {
    let finished = 0;
    const view = await openSetup(
      aClient({
        state: () =>
          Promise.resolve(atFinish({ workspace: null, canFinish: true, finishProblems: [] })),
        finish: () => {
          finished += 1;
          return Promise.resolve();
        },
      }),
    );
    await press(view, 'Finish setup');
    expect(finished).toBe(1);
    expect(view.world.history.stack.at(-1)).toBe('/');
  });

  test('says a failure to finish, enables the button again, and follows the claim being lost', async () => {
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(atFinish({ canFinish: true, finishProblems: [] })),
        finish: () => Promise.reject(new SetupFailure(0, 'NETWORK', 'down')),
      }),
    );
    await press(view, 'Finish setup');
    expect(view.getByRole('alert').textContent).toContain(en['setup.finish.failed']);
    expect((view.getByRole('button', { name: 'Finish setup' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    view.unmount();
    const lost = await openSetup(
      losing(atFinish({ canFinish: true, finishProblems: [] }), 'finish'),
    );
    await press(lost, 'Finish setup');
    expect(lost.getByRole('heading', { name: /code/i })).toBeDefined();
  });
});
