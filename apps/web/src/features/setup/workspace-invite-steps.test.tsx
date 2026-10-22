/**
 * The wizard's last two working screens (UX §11, D-124): the first workspace — a name, an address that
 * follows it until it is edited, and the server's refusals said where they belong — and the
 * invitations, a link made once and mail where mail is connected, which can also be skipped.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import type { CreatedInvitation, SetupState } from '@purlay/types';
import { ApiError } from '../../data/errors';
import { en } from '../../i18n/catalogue/en';
import { installDom } from '../../testing/dom';
import { anApi } from '../../testing/fake-api';
import { aSession, WHEN } from '../../testing/fixtures';
import { person } from '../../testing/user';
import { SetupFailure } from './client';
import { aClient, aState, openSetup, ORIGIN, settle, unheld } from './testing';

installDom();

const PASSED = ['claim', 'admin', 'address', 'policy', 'github', 'email'] as const;
const ADMIN = { name: 'Ayse', email: 'ayse@example.test', emailVerified: false };
const TOKEN = 'e'.repeat(64);

const atWorkspace = (over: Partial<SetupState> = {}): SetupState =>
  aState({ steps: [...PASSED], admin: ADMIN, ...over });

const atInvite = (over: Partial<SetupState> = {}): SetupState =>
  aState({
    steps: [...PASSED, 'workspace'],
    admin: ADMIN,
    workspace: { id: 'w1', name: 'Acme', slug: 'acme' },
    ...over,
  });

const createdWith = (mail?: CreatedInvitation['mail']): CreatedInvitation => ({
  invitation: { id: 'i1', createdBy: aSession().user, createdAt: WHEN, expiresAt: WHEN },
  token: TOKEN,
  ...(mail === undefined ? {} : { mail }),
});

describe('the first workspace', () => {
  const open = async (
    workspace: (input: { name: string; slug: string }) => Promise<void>,
    state: () => Promise<SetupState> = () => Promise.resolve(atWorkspace()),
  ): Promise<Awaited<ReturnType<typeof openSetup>>> =>
    await openSetup(aClient({ state, workspace }));

  test('makes the address from the name until the address is edited by hand', async () => {
    const view = await open(() => Promise.resolve());
    const name = view.getByLabelText('Name');
    const address = view.getByLabelText('Address') as HTMLInputElement;
    await person().type(name, 'Acme Metal Works');
    expect(address.value).toBe('acme-metal-works');
    expect(
      view.getByText(`Your team will open it at ${window.location.origin}/w/acme-metal-works`),
    ).toBeDefined();
    await person().clear(address);
    await person().type(address, 'METAL');
    expect(address.value).toBe('metal');
    await person().type(name, ' Two');
    expect(address.value).toBe('metal');
  });

  test('sends the trimmed name and the address, then shows the next screen from the new state', async () => {
    const sent: unknown[] = [];
    let state = atWorkspace();
    const view = await open(
      (input) => {
        sent.push(input);
        state = atInvite();
        return Promise.resolve();
      },
      () => Promise.resolve(state),
    );
    await person().type(view.getByLabelText('Name'), '  Acme  ');
    await person().click(view.getByRole('button', { name: 'Create workspace' }));
    await settle();
    expect(sent).toEqual([{ name: 'Acme', slug: 'acme' }]);
    expect(view.getByRole('heading', { name: 'Invite your team' })).toBeDefined();
  });

  test('says a blank name and an unusable address without sending anything', async () => {
    const sent: unknown[] = [];
    const view = await open((input) => {
      sent.push(input);
      return Promise.resolve();
    });
    await person().click(view.getByRole('button', { name: 'Create workspace' }));
    expect(view.getByText(en['setup.admin.nameBlank'])).toBeDefined();
    await person().type(view.getByLabelText('Name'), 'Acme');
    await person().clear(view.getByLabelText('Address'));
    await person().type(view.getByLabelText('Address'), 'not valid!');
    await person().click(view.getByRole('button', { name: 'Create workspace' }));
    expect(view.getByText(en['workspace.create.invalid'])).toBeDefined();
    expect(sent).toEqual([]);
  });

  test('says an address that is taken, and one the server found invalid, on the address', async () => {
    const codes = ['WORKSPACE_SLUG_TAKEN', 'VALIDATION_FAILED'] as const;
    const said = [en['workspace.create.taken'], en['workspace.create.invalid']];
    for (const [index, code] of codes.entries()) {
      const view = await open(() => Promise.reject(new SetupFailure(409, code, 'no')));
      await person().type(view.getByLabelText('Name'), 'Acme');
      await person().click(view.getByRole('button', { name: 'Create workspace' }));
      await settle();
      expect(view.getByLabelText('Address').getAttribute('aria-invalid')).toBe('true');
      expect(view.getByText(said[index] ?? '')).toBeDefined();
      view.unmount();
    }
  });

  test('says any other failure as a sentence, and keeps what was typed', async () => {
    const view = await open(() => Promise.reject(new SetupFailure(0, 'NETWORK', 'down')));
    await person().type(view.getByLabelText('Name'), 'Acme');
    await person().click(view.getByRole('button', { name: 'Create workspace' }));
    await settle();
    expect(view.getByRole('alert').textContent).toContain(en['setup.failed.network']);
    expect((view.getByLabelText('Name') as HTMLInputElement).value).toBe('Acme');
  });

  test('goes back to the code when the server no longer holds the claim', async () => {
    let held = true;
    const view = await openSetup(
      aClient({
        state: () => (held ? Promise.resolve(atWorkspace()) : unheld()),
        workspace: () => {
          held = false;
          return Promise.reject(new SetupFailure(404, 'SETUP_UNAVAILABLE', 'gone'));
        },
      }),
    );
    await person().type(view.getByLabelText('Name'), 'Acme');
    await person().click(view.getByRole('button', { name: 'Create workspace' }));
    await settle();
    expect(view.getByRole('heading', { name: /code/i })).toBeDefined();
  });

  test('shows a workspace that exists, with its address, and goes on without sending it again', async () => {
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(atInvite()),
      }),
    );
    // The server holds it as made: the wizard resumes at the invitations, and Back shows the workspace.
    await person().click(view.getByRole('button', { name: 'Back' }));
    expect(
      view.getByText(`The workspace Acme exists at ${window.location.origin}/w/acme.`),
    ).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Continue' }));
    expect(view.getByRole('heading', { name: 'Invite your team' })).toBeDefined();
  });
});

describe('the invitations', () => {
  const copied = (): { texts: string[]; stop: () => void } => {
    const texts: string[] = [];
    const clipboard = spyOn(navigator.clipboard, 'writeText').mockImplementation((text) => {
      texts.push(text);
      return Promise.resolve();
    });
    return {
      texts,
      stop: (): void => {
        clipboard.mockRestore();
      },
    };
  };

  const open = async (
    api: Parameters<typeof anApi>[0],
    state: SetupState,
    invite: () => Promise<void> = () => Promise.resolve(),
  ): Promise<Awaited<ReturnType<typeof openSetup>>> =>
    await openSetup(aClient({ state: () => Promise.resolve(state), invite }), {
      api: anApi({
        setupStatus: () => Promise.resolve({ open: true, appUrl: ORIGIN }),
        ...api,
      }),
    });

  test('makes one link for the workspace, shows it whole, and copies it', async () => {
    const asked: unknown[] = [];
    const view = await open(
      {
        createInvitation: (workspaceId, mail) => {
          asked.push([workspaceId, mail]);
          return Promise.resolve(createdWith());
        },
      },
      atInvite(),
    );
    expect(view.getByRole('button', { name: 'Skip for now' })).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Make an invitation link' }));
    await settle();
    expect(asked).toEqual([['w1', undefined]]);
    expect(view.getByText(`${window.location.origin}/invite#${TOKEN}`)).toBeDefined();
    expect(view.queryByRole('button', { name: 'Make an invitation link' })).toBeNull();
    expect(view.getByRole('button', { name: 'Continue' })).toBeDefined();
    const clipboard = copied();
    await person().click(view.getByRole('button', { name: 'Copy' }));
    await settle();
    expect(clipboard.texts).toEqual([`${window.location.origin}/invite#${TOKEN}`]);
    expect(view.getByRole('button', { name: 'Copied' })).toBeDefined();
    clipboard.stop();
  });

  test('offers mail only where a mail channel is connected', async () => {
    const without = await open({}, atInvite());
    expect(without.queryByLabelText('Email addresses')).toBeNull();
    without.unmount();
    const withMail = await open({}, atInvite({ channels: { github: false, email: true } }));
    expect(withMail.getByLabelText('Email addresses')).toBeDefined();
    expect(
      (withMail.getByRole('button', { name: 'Send invitations' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test('sends the addresses typed, says how many went, and keeps the ones that did not', async () => {
    const asked: unknown[] = [];
    const view = await open(
      {
        createInvitation: (workspaceId, mail) => {
          asked.push([workspaceId, mail]);
          return Promise.resolve(
            createdWith([
              { address: 'ada@example.test', outcome: 'queued' },
              { address: 'grace@example.test', outcome: 'unavailable' },
            ]),
          );
        },
      },
      atInvite({ channels: { github: false, email: true } }),
    );
    const field = view.getByLabelText('Email addresses');
    await person().type(field, 'ada@example.test, grace@example.test,');
    await person().click(view.getByRole('button', { name: 'Send 2 invitations' }));
    await settle();
    expect(asked).toEqual([
      ['w1', { emails: ['ada@example.test', 'grace@example.test'], locale: 'en' }],
    ]);
    expect(view.getByText('Not sent: grace@example.test.')).toBeDefined();
    expect(view.queryByText('Remove ada@example.test')).toBeNull();
    expect(view.getByRole('button', { name: 'Remove grace@example.test' })).toBeDefined();
    expect(view.getByText(`${window.location.origin}/invite#${TOKEN}`)).toBeDefined();
  });

  test('says a link that could not be made, with the reason in a sentence, and offers it again', async () => {
    const view = await open(
      { createInvitation: () => Promise.reject(new ApiError(403, 'FORBIDDEN', 'no')) },
      atInvite(),
    );
    await person().click(view.getByRole('button', { name: 'Make an invitation link' }));
    await settle();
    expect(view.getByRole('alert').textContent).toContain(en['setup.invite.failed']);
    expect(view.getByRole('button', { name: 'Make an invitation link' })).toBeDefined();
  });

  test('passes the step and shows the next screen, with or without a link', async () => {
    let calls = 0;
    let state = atInvite();
    const view = await openSetup(
      aClient({
        state: () => Promise.resolve(state),
        invite: () => {
          calls += 1;
          state = atInvite({ steps: [...PASSED, 'workspace', 'invite'] });
          return Promise.resolve();
        },
      }),
    );
    await person().click(view.getByRole('button', { name: 'Skip for now' }));
    await settle();
    expect(calls).toBe(1);
    expect(view.getByRole('button', { name: 'Finish setup' })).toBeDefined();
  });

  test('says a failed pass in a sentence, and goes back to the code when the claim is gone', async () => {
    const failing = await open({}, atInvite(), () =>
      Promise.reject(new SetupFailure(0, 'NETWORK', 'down')),
    );
    await person().click(failing.getByRole('button', { name: 'Skip for now' }));
    await settle();
    expect(failing.getByRole('alert').textContent).toContain(en['setup.failed.network']);
    failing.unmount();

    let held = true;
    const lost = await openSetup(
      aClient({
        state: () => (held ? Promise.resolve(atInvite()) : unheld()),
        invite: () => {
          held = false;
          return Promise.reject(new SetupFailure(404, 'SETUP_UNAVAILABLE', 'gone'));
        },
      }),
    );
    await person().click(lost.getByRole('button', { name: 'Skip for now' }));
    await settle();
    expect(lost.getByRole('heading', { name: /code/i })).toBeDefined();
  });

  test('goes back one screen', async () => {
    const view = await open({}, atInvite());
    await person().click(view.getByRole('button', { name: 'Back' }));
    expect(view.getByRole('heading', { name: 'Create the first workspace' })).toBeDefined();
  });
});
