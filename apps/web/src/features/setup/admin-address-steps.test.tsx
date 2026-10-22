/**
 * The administrator and the address screens (UX §11, D-179 §4): what the form refuses before it sends,
 * where each of the server's refusals is said, the cases where the account exists but the browser is
 * not signed in, and that the address and the policy are two calls made in that order.
 */
import { describe, expect, test } from 'bun:test';
import type { SetupState } from '@purlay/types';
import { en } from '../../i18n/catalogue/en';
import { installDom } from '../../testing/dom';
import { person } from '../../testing/user';
import { SetupFailure } from './client';
import { aClient, aState, openSetup, settle, unheld } from './testing';

installDom();

const ADMIN = { name: 'Ayse', email: 'ayse@example.test', emailVerified: false };
const GOOD = 'a long and unusual phrase 7';

type Admin = Parameters<ReturnType<typeof aClient>['admin']>[0];

const fillAdmin = async (
  view: Awaited<ReturnType<typeof openSetup>>,
  password = GOOD,
): Promise<void> => {
  const user = person();
  await user.type(view.getByLabelText('Name'), ' Ayse ');
  await user.type(view.getByLabelText('Email address'), ' ayse@example.test ');
  await user.type(view.getByLabelText('Password'), password);
};

const submitAdmin = async (view: Awaited<ReturnType<typeof openSetup>>): Promise<void> => {
  await person().click(view.getByRole('button', { name: 'Create account' }));
  await settle();
};

describe('the administrator’s form', () => {
  test('says what is missing, field by field, and sends nothing; typing in a field takes its sentence away', async () => {
    const sent: Admin[] = [];
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(aState()),
        admin: (input) => {
          sent.push(input);
          return Promise.resolve({ signedIn: true });
        },
      }),
    );
    await submitAdmin(view);
    expect(view.getByText(en['setup.admin.nameBlank'])).toBeDefined();
    expect(view.getByText(en['setup.admin.emailInvalid'])).toBeDefined();
    expect(view.getByText(en['setup.admin.problem.too-short'])).toBeDefined();
    expect(sent).toEqual([]);
    await person().type(view.getByLabelText('Name'), 'A');
    expect(view.queryByText(en['setup.admin.nameBlank'])).toBeNull();
    await person().type(view.getByLabelText('Email address'), 'a@b.test');
    expect(view.queryByText(en['setup.admin.emailInvalid'])).toBeNull();
    await person().type(view.getByLabelText('Password'), 'x');
    expect(view.queryByText(en['setup.admin.problem.too-short'])).toBeNull();
  });

  test('shows and hides the password on request', async () => {
    const view = await openSetup(aClient({ state: () => Promise.resolve(aState()) }));
    const field = view.getByLabelText('Password') as HTMLInputElement;
    expect(field.type).toBe('password');
    await person().click(view.getByRole('button', { name: 'Show the password' }));
    expect(field.type).toBe('text');
    expect(
      view.getByRole('button', { name: 'Hide the password' }).getAttribute('aria-pressed'),
    ).toBe('true');
    await person().click(view.getByRole('button', { name: 'Hide the password' }));
    expect(field.type).toBe('password');
  });

  test('sends the trimmed name and address and the password as typed, then moves on from the new state', async () => {
    const sent: Admin[] = [];
    let state: SetupState = aState();
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(state),
        admin: (input) => {
          sent.push(input);
          state = aState({ steps: ['claim', 'admin'], admin: ADMIN });
          return Promise.resolve({ signedIn: true });
        },
      }),
    );
    await fillAdmin(view);
    await submitAdmin(view);
    expect(sent).toEqual([{ name: 'Ayse', email: 'ayse@example.test', password: GOOD }]);
    expect(view.getByRole('heading', { name: 'Confirm the server address' })).toBeDefined();
  });

  test('says where the server found each field wrong, and a password rule it names in words', async () => {
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(aState()),
        admin: () =>
          Promise.reject(
            new SetupFailure(422, 'VALIDATION_FAILED', 'no', null, {
              name: 'blank',
              email: 'invalid',
              password: 'common',
            }),
          ),
      }),
    );
    await fillAdmin(view);
    await submitAdmin(view);
    expect(view.getByText(en['setup.admin.nameBlank'])).toBeDefined();
    expect(view.getByText(en['setup.admin.emailInvalid'])).toBeDefined();
    expect(view.getByText(en['setup.admin.problem.common'])).toBeDefined();
  });

  test('says a password rule it does not know in the generic sentence', async () => {
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(aState()),
        admin: () =>
          Promise.reject(
            new SetupFailure(422, 'VALIDATION_FAILED', 'no', null, { password: 'unheard-of' }),
          ),
      }),
    );
    await fillAdmin(view);
    await submitAdmin(view);
    expect(view.getByText(en['setup.failed.generic'])).toBeDefined();
  });

  test('says an address that already has an account, on the address', async () => {
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(aState()),
        admin: () => Promise.reject(new SetupFailure(409, 'ACCOUNT_EMAIL_CONFLICT', 'no')),
      }),
    );
    await fillAdmin(view);
    await submitAdmin(view);
    expect(view.getByText(en['setup.admin.conflict'])).toBeDefined();
    expect(view.getByLabelText('Email address').getAttribute('aria-invalid')).toBe('true');
  });

  test('reads the state again when the server says the administrator exists already', async () => {
    let state: SetupState = aState();
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(state),
        admin: () => {
          state = aState({ steps: ['claim', 'admin'], admin: ADMIN });
          return Promise.reject(
            new SetupFailure(409, 'SETUP_STEP_REFUSED', 'no', null, {}, 'admin-exists'),
          );
        },
      }),
    );
    await fillAdmin(view);
    await submitAdmin(view);
    expect(view.getByRole('heading', { name: 'Confirm the server address' })).toBeDefined();
  });

  test('says any other failure as a sentence and keeps what was typed', async () => {
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(aState()),
        admin: () => Promise.reject(new SetupFailure(0, 'NETWORK', 'down')),
      }),
    );
    await fillAdmin(view);
    await submitAdmin(view);
    expect(view.getByRole('alert').textContent).toContain(en['setup.failed.network']);
    expect((view.getByLabelText('Name') as HTMLInputElement).value).toBe(' Ayse ');
  });

  test('goes back to the code when the server no longer holds the claim', async () => {
    let held = true;
    const view = await openSetup(
      aClient({
        state: () => (held ? Promise.resolve(aState()) : unheld()),
        admin: () => {
          held = false;
          return Promise.reject(new SetupFailure(404, 'SETUP_UNAVAILABLE', 'gone'));
        },
      }),
    );
    await fillAdmin(view);
    await submitAdmin(view);
    expect(view.getByRole('heading', { name: /code/i })).toBeDefined();
  });

  test('says the account was made but this browser is not signed in, and goes on only when told to', async () => {
    let state: SetupState = aState();
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(state),
        admin: () => {
          state = aState({ steps: ['claim', 'admin'], admin: ADMIN });
          return Promise.resolve({ signedIn: false });
        },
      }),
    );
    await fillAdmin(view);
    await submitAdmin(view);
    expect(view.getByText(en['setup.admin.notSignedIn'])).toBeDefined();
    expect(view.queryByRole('heading', { name: 'Confirm the server address' })).toBeNull();
    await person().click(view.getByRole('button', { name: 'Continue' }));
    await settle();
    expect(view.getByRole('heading', { name: 'Confirm the server address' })).toBeDefined();
  });

  test('shows the administrator that exists, with Continue, and Back to the code is not offered', async () => {
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(aState({ steps: ['claim', 'admin'], admin: ADMIN })),
      }),
    );
    // Resumes at the address; Back, then Back again, shows the administrator and its way on.
    await person().click(view.getByRole('button', { name: 'Back' }));
    expect(view.getByText('The administrator is Ayse, ayse@example.test.')).toBeDefined();
    expect(view.queryByRole('button', { name: 'Back' })).toBeNull();
    await person().click(view.getByRole('button', { name: 'Continue' }));
    expect(view.getByRole('heading', { name: 'Confirm the server address' })).toBeDefined();
  });
});

describe('the address and the policy', () => {
  const atAddress = (over: Partial<SetupState> = {}): SetupState =>
    aState({ steps: ['claim', 'admin'], admin: ADMIN, ...over });

  test('shows the address and the GitHub callback to copy, and starts on the safer policy', async () => {
    const view = await openSetup(aClient({ state: () => Promise.resolve(atAddress()) }));
    expect(view.getByText('https://purlay.test')).toBeDefined();
    expect(view.getByText('https://purlay.test/auth/callback/github')).toBeDefined();
    expect(
      (view.getByRole('radio', { name: /Only people who are invited/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  test('confirms the address first, then sets the policy chosen, then reads the state', async () => {
    const calls: string[] = [];
    let state = atAddress();
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(state),
        confirmAddress: () => {
          calls.push('address');
          return Promise.resolve();
        },
        policy: (signUp) => {
          calls.push(`policy:${signUp}`);
          state = atAddress({ steps: ['claim', 'admin', 'address', 'policy'] });
          return Promise.resolve();
        },
      }),
    );
    await person().click(view.getByRole('radio', { name: /Anyone can create an account/ }));
    await person().click(view.getByRole('button', { name: 'Confirm and continue' }));
    await settle();
    expect(calls).toEqual(['address', 'policy:open']);
    expect(view.getByRole('heading', { name: 'Sign in with GitHub' })).toBeDefined();
  });

  test('does not set the policy when the address could not be confirmed, and says why', async () => {
    const calls: string[] = [];
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(atAddress()),
        confirmAddress: () => Promise.reject(new SetupFailure(0, 'NETWORK', 'down')),
        policy: () => {
          calls.push('policy');
          return Promise.resolve();
        },
      }),
    );
    await person().click(view.getByRole('button', { name: 'Confirm and continue' }));
    await settle();
    expect(calls).toEqual([]);
    expect(view.getByRole('alert').textContent).toContain(en['setup.failed.network']);
  });

  test('goes back to the code when the server no longer holds the claim', async () => {
    let held = true;
    const view = await openSetup(
      aClient({
        state: () => (held ? Promise.resolve(atAddress()) : unheld()),
        confirmAddress: () => {
          held = false;
          return Promise.reject(new SetupFailure(404, 'SETUP_UNAVAILABLE', 'gone'));
        },
      }),
    );
    await person().click(view.getByRole('button', { name: 'Confirm and continue' }));
    await settle();
    expect(view.getByRole('heading', { name: /code/i })).toBeDefined();
  });

  test('shows the policy that was chosen when the screen is passed again, and goes back one screen', async () => {
    const view = await openSetup(
      aClient({
        state: () =>
          Promise.resolve(
            atAddress({
              steps: ['claim', 'admin', 'address', 'policy', 'github'],
              settings: { ...aState().settings, signUp: 'open' },
            }),
          ),
      }),
    );
    await person().click(view.getByRole('button', { name: 'Back' }));
    await person().click(view.getByRole('button', { name: 'Back' }));
    expect(view.getByRole('heading', { name: 'Confirm the server address' })).toBeDefined();
    expect(
      (view.getByRole('radio', { name: /Anyone can create an account/ }) as HTMLInputElement)
        .checked,
    ).toBe(true);
    await person().click(view.getByRole('button', { name: 'Back' }));
    expect(view.getByRole('heading', { name: 'Create the administrator account' })).toBeDefined();
  });
});
