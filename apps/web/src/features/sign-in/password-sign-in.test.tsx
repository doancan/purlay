/**
 * Signing in with a password (R30), against the fake API: what is sent, where a success goes, and the
 * one sentence for each way it can fail — a wrong address and a wrong password are the same words, a
 * wait is told in minutes, and a server that did not answer is not blamed on the person.
 */
import { describe, expect, test } from 'bun:test';
import { act } from '@testing-library/react';
import { Outlet } from '../../app/outlet';
import type { Api } from '../../data/api';
import { ApiError, LibraryFailure } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { aSession, aSignedInApi } from '../../testing/fixtures';
import { person } from '../../testing/user';
import { renderApp } from '../../testing/render';

installDom();

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const visit = async (
  overrides: Partial<Api>,
  locale: 'en' | 'tr' = 'en',
): Promise<Awaited<ReturnType<typeof renderApp>>> => {
  let signedIn = false;
  const api = aSignedInApi({
    me: () =>
      signedIn
        ? Promise.resolve(aSession())
        : Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'no')),
    authMethods: () => Promise.resolve({ github: false, email: false, signUp: 'invite-only' }),
    ...overrides,
    ...(overrides.signInWithPassword === undefined
      ? {}
      : {
          signInWithPassword: async (input: { email: string; password: string }): Promise<void> => {
            await overrides.signInWithPassword?.(input);
            signedIn = true;
          },
        }),
  });
  const view = await renderApp(<Outlet />, { path: '/sign-in', api, locale });
  await settle();
  return view;
};

const submit = async (
  view: Awaited<ReturnType<typeof renderApp>>,
  words: { email: string; password: string },
): Promise<void> => {
  const user = person();
  await user.type(view.getByRole('textbox', { name: 'Email address' }), words.email);
  await user.type(view.getByLabelText('Password'), words.password);
  await user.click(view.getByRole('button', { name: 'Sign in' }));
  await settle();
};

describe('the password form on the sign-in card', () => {
  test('sends the address trimmed and the password as typed, then the person is let in', async () => {
    const sent: { email: string; password: string }[] = [];
    const view = await visit({
      signInWithPassword: async (input) => {
        sent.push(input);
        await Promise.resolve();
      },
    });
    await expectNoAxeViolations(view.container);
    await submit(view, { email: ' admin@example.test ', password: ' pass word 123 ' });
    expect(sent).toEqual([{ email: 'admin@example.test', password: ' pass word 123 ' }]);
    // The session is there: the screen asks who it is and sends the person on.
    expect(view.world.history.stack.at(-1)).not.toBe('/sign-in');
  });

  test.each([
    [new LibraryFailure(401, 'INVALID_EMAIL_OR_PASSWORD'), 'Wrong email or password.'],
    // A shape the library would not read says no more than a wrong password does.
    [new LibraryFailure(400, 'INVALID_EMAIL'), 'Wrong email or password.'],
    [
      new LibraryFailure(429, 'RATE_LIMITED', null, 600),
      'Too many attempts. Try again in 10 minutes.',
    ],
    [
      new LibraryFailure(429, 'RATE_LIMITED', null, 61),
      'Too many attempts. Try again in 2 minutes.',
    ],
    [new LibraryFailure(429, 'RATE_LIMITED', null, 5), 'Too many attempts. Try again in 1 minute.'],
    [new LibraryFailure(429, 'RATE_LIMITED'), 'Too many attempts. Try again in 1 minute.'],
    [
      new LibraryFailure(500, 'INTERNAL_SERVER_ERROR'),
      'Signing in did not finish. Try again in a moment.',
    ],
    [new LibraryFailure(503, 'MALFORMED'), 'Signing in did not finish. Try again in a moment.'],
    [
      new LibraryFailure(0, 'NETWORK'),
      'Purlay could not be reached. Check your connection and try again.',
    ],
  ])('%s is said in one sentence and the form stays', async (failure, words) => {
    const view = await visit({ signInWithPassword: () => Promise.reject(failure) });
    await submit(view, { email: 'ada@example.test', password: 'whatever-it-is' });
    expect(view.getByRole('alert').textContent).toBe(words);
    expect(view.getByLabelText('Password').getAttribute('aria-invalid')).toBe('true');
    expect(view.world.history.stack.at(-1)).toBe('/sign-in');
  });

  test('an address nobody has and a wrong password read exactly alike', async () => {
    const said: string[] = [];
    for (const address of ['nobody@example.test', 'admin@example.test']) {
      const view = await visit({
        signInWithPassword: () =>
          Promise.reject(new LibraryFailure(401, 'INVALID_EMAIL_OR_PASSWORD')),
      });
      await submit(view, { email: address, password: 'not-the-password' });
      said.push(view.getByRole('alert').outerHTML.replace(/id="[^"]*"/g, ''));
      view.unmount();
    }
    expect(said[0]).toBe(said[1]);
  });

  test('says the same in Turkish', async () => {
    const view = await visit(
      {
        signInWithPassword: () =>
          Promise.reject(new LibraryFailure(401, 'INVALID_EMAIL_OR_PASSWORD')),
      },
      'tr',
    );
    const user = person();
    await user.type(view.getByRole('textbox', { name: 'E-posta adresi' }), 'ada@example.test');
    await user.type(view.getByLabelText('Parola'), 'yanlis-parola');
    await user.click(view.getByRole('button', { name: 'Giriş yap' }));
    await settle();
    expect(view.getByRole('alert').textContent).toBe('E-posta ya da parola yanlış.');
  });
});
