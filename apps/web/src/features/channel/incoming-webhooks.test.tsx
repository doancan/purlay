/**
 * A channel's incoming webhooks in its details (D-245): an owner's or an admin's, in its three states
 * (`UX.md` §8) with a real failure; who made each and when it last posted; making one, which shows its
 * address once; a name the server refuses said on the field; revoking one, which asks first. And what a
 * hook posts, in the feed: under its name, with the word *webhook* beside it, its markdown drawn and its
 * markup never run.
 */
import { describe, expect, test } from 'bun:test';
import { within } from '@testing-library/react';
import type { CreateIncomingWebhookRequest, IncomingWebhook, MeResponse } from '@purlay/types';
import { ApiError } from '../../data/errors';
import { expectNoAxeViolations } from '../../testing/axe';
import { expectFocusOn } from '../../testing/focus';
import { mountChannel, page, settle, type ChannelView } from '../../testing/channel-harness';
import { installDom } from '../../testing/dom';
import { IDS, aMessage, aSession } from '../../testing/fixtures';
import { person } from '../../testing/user';

installDom();

const HOOK_ID = '0199155c-6200-7b7f-8c11-000000000a01';
const SECRET = 'b'.repeat(64);

const aHook = (over: Partial<IncomingWebhook> = {}): IncomingWebhook => ({
  id: HOOK_ID,
  channelId: IDS.api,
  name: 'CI',
  createdBy: { id: IDS.me, username: 'dogancan', displayName: 'Doğancan', avatarUrl: null },
  createdAt: '2026-11-01T08:00:00.000Z',
  lastUsedAt: null,
  ...over,
});

const openDetails = async (view: ChannelView): Promise<HTMLElement> => {
  await person().click(view.getByRole('button', { name: 'api' }));
  await settle();
  const dialog = await view.findByRole('dialog', { name: 'Details of #api' });
  const tab = within(dialog).queryByRole('tab', { name: 'Integrations' });
  if (tab !== null) {
    await person().click(tab);
    await settle();
  }
  return dialog;
};

const hooksOf = (dialog: HTMLElement): HTMLElement =>
  within(dialog).getByRole('region', { name: 'Incoming webhooks' });

describe('a channel’s incoming webhooks, as an owner sees them', () => {
  test('a failure is said with Retry, and read again it is the empty state', async () => {
    let mended = false;
    const view = await mountChannel({
      messages: page([]),
      api: {
        incomingWebhooks: () =>
          mended ? Promise.resolve([]) : Promise.reject(new ApiError(500, 'INTERNAL', 'boom')),
      },
    });
    const dialog = await openDetails(view);
    const hooks = hooksOf(dialog);
    expect(within(hooks).getByText(/went wrong/i)).toBeDefined();
    mended = true;
    await person().click(within(hooks).getByRole('button', { name: 'Retry' }));
    await settle();
    expect(within(hooks).getByText(/No incoming webhook/)).toBeDefined();
    await expectNoAxeViolations(dialog);
    view.unmountAll();
  });

  test('while it loads, a skeleton; then each hook says who made it and when it last posted', async () => {
    let answer: (hooks: IncomingWebhook[]) => void = () => undefined;
    const view = await mountChannel({
      messages: page([]),
      api: {
        incomingWebhooks: () =>
          new Promise((resolve) => {
            answer = resolve;
          }),
      },
    });
    const hooks = hooksOf(await openDetails(view));
    expect(within(hooks).getByRole('status').getAttribute('aria-busy')).toBe('true');
    expect(within(hooks).getByText('Loading')).toBeDefined();
    answer([
      aHook({ lastUsedAt: '2026-11-01T09:00:00.000Z' }),
      aHook({ id: '0199155c-6200-7b7f-8c11-000000000a02', name: 'Alerts', createdBy: null }),
    ]);
    await settle();
    expect(within(hooks).getByText('CI')).toBeDefined();
    expect(within(hooks).getByText(/Made by Doğancan .* · Last posted/)).toBeDefined();
    expect(within(hooks).getByText(/^Made .* · Not used yet$/)).toBeDefined();
    view.unmountAll();
  });

  test('making one shows its address once, copied, until Done', async () => {
    const asked: CreateIncomingWebhookRequest[] = [];
    const copied: string[] = [];
    let listed = 0;
    const view = await mountChannel({
      messages: page([]),
      copy: (text) => {
        copied.push(text);
        return Promise.resolve();
      },
      api: {
        incomingWebhooks: () => {
          listed += 1;
          return Promise.resolve(listed === 1 ? [] : [aHook()]);
        },
        createIncomingWebhook: (_channelId, input) => {
          asked.push(input);
          return Promise.resolve({
            webhook: aHook(),
            path: `/api/webhooks/incoming/${HOOK_ID}/${SECRET}`,
          });
        },
      },
    });
    const dialog = await openDetails(view);
    const hooks = hooksOf(dialog);
    await person().type(within(hooks).getByLabelText(/^Posts as/), '  CI  ');
    await person().click(within(hooks).getByRole('button', { name: 'Make webhook' }));
    await settle();

    expect(asked).toEqual([{ name: 'CI' }]);
    const setup = within(hooks).getByRole('region', { name: 'The address of CI' });
    const address = `${window.location.origin}/api/webhooks/incoming/${HOOK_ID}/${SECRET}`;
    expect(within(setup).getByText(address)).toBeDefined();
    expect(within(setup).getByText(/\{"text":"Deploy finished"\}/)).toBeDefined();
    expectFocusOn(within(setup).getByRole('heading'));
    await person().click(within(setup).getByRole('button', { name: 'Copy the address' }));
    await settle();
    expect(copied).toEqual([address]);
    await expectNoAxeViolations(dialog);

    await person().click(within(setup).getByRole('button', { name: 'Done' }));
    expect(within(hooks).queryByText(address)).toBeNull();
    expect(within(hooks).getByRole('button', { name: 'Make webhook' })).toBeDefined();
    view.unmountAll();
  });

  test('a blank name is said before a round trip; a refused one on its field; the cap above the form', async () => {
    const answers = [
      new ApiError(400, 'VALIDATION_FAILED', 'no', { name: 'too long' }),
      new ApiError(409, 'INCOMING_WEBHOOKS_LIMIT', 'full'),
    ];
    let made = 0;
    const view = await mountChannel({
      messages: page([]),
      api: {
        incomingWebhooks: () => Promise.resolve([]),
        createIncomingWebhook: () => {
          made += 1;
          return Promise.reject(answers.shift() ?? new Error('asked once too often'));
        },
      },
    });
    const hooks = hooksOf(await openDetails(view));
    const field = within(hooks).getByLabelText(/^Posts as/);
    await person().type(field, '   ');
    await person().click(within(hooks).getByRole('button', { name: 'Make webhook' }));
    expect(within(hooks).getByText('Give the webhook a name.')).toBeDefined();
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(made).toBe(0);

    await person().type(field, 'CI');
    await person().click(within(hooks).getByRole('button', { name: 'Make webhook' }));
    await settle();
    expect(within(hooks).getByText(/Use a shorter name/)).toBeDefined();
    expect(field.getAttribute('aria-invalid')).toBe('true');

    await person().click(within(hooks).getByRole('button', { name: 'Make webhook' }));
    await settle();
    expect(within(hooks).getByRole('alert').textContent).toContain(
      'as many incoming webhooks as a channel has',
    );
    expect(made).toBe(2);
    view.unmountAll();
  });

  test('revoking asks first; Cancel gives focus back; Revoke removes it', async () => {
    const revoked: [string, string][] = [];
    let listed = 0;
    const view = await mountChannel({
      messages: page([]),
      api: {
        incomingWebhooks: () => {
          listed += 1;
          return Promise.resolve(listed === 1 ? [aHook()] : []);
        },
        revokeIncomingWebhook: (channelId, webhookId) => {
          revoked.push([channelId, webhookId]);
          return Promise.resolve();
        },
      },
    });
    const hooks = hooksOf(await openDetails(view));
    await person().click(within(hooks).getByRole('button', { name: 'Revoke CI' }));
    const question = within(hooks).getByRole('group', { name: /Revoke CI\?/ });
    expectFocusOn(within(question).getByRole('button', { name: 'Cancel' }));
    await person().click(within(question).getByRole('button', { name: 'Cancel' }));
    expectFocusOn(within(hooks).getByRole('button', { name: 'Revoke CI' }));
    expect(revoked).toEqual([]);

    await person().click(within(hooks).getByRole('button', { name: 'Revoke CI' }));
    await person().click(
      within(within(hooks).getByRole('group', { name: /Revoke CI\?/ })).getByRole('button', {
        name: 'Revoke',
      }),
    );
    await settle();
    expect(revoked).toEqual([[IDS.api, HOOK_ID]]);
    expect(within(hooks).getByText(/No incoming webhook/)).toBeDefined();
    view.unmountAll();
  });

  test('a revoke refused puts the row back and says why', async () => {
    const view = await mountChannel({
      messages: page([]),
      api: {
        incomingWebhooks: () => Promise.resolve([aHook()]),
        revokeIncomingWebhook: () =>
          Promise.reject(new ApiError(404, 'INCOMING_WEBHOOK_NOT_FOUND', 'gone')),
      },
    });
    const hooks = hooksOf(await openDetails(view));
    await person().click(within(hooks).getByRole('button', { name: 'Revoke CI' }));
    await person().click(
      within(within(hooks).getByRole('group', { name: /Revoke CI\?/ })).getByRole('button', {
        name: 'Revoke',
      }),
    );
    await settle();
    expect(within(hooks).getByRole('alert').textContent).toContain('Couldn’t revoke the webhook.');
    expect(within(hooks).getByRole('button', { name: 'Revoke CI' })).toBeDefined();
    view.unmountAll();
  });
});

describe('as a member', () => {
  test('there is no webhooks section, and nothing is asked for', async () => {
    const session = aSession();
    const member: MeResponse = {
      ...session,
      memberships: session.memberships.map((m) => ({ ...m, role: 'member' as const })),
    };
    let asked = 0;
    const view = await mountChannel({
      messages: page([]),
      api: {
        me: () => Promise.resolve(member),
        incomingWebhooks: () => {
          asked += 1;
          return Promise.resolve([]);
        },
      },
    });
    const dialog = await openDetails(view);
    expect(within(dialog).queryByRole('region', { name: 'Incoming webhooks' })).toBeNull();
    expect(asked).toBe(0);
    view.unmountAll();
  });
});

describe('what a hook posts, in the feed', () => {
  test('under the hook’s name with the word webhook, its markdown drawn and its markup never run', async () => {
    const posted = aMessage(1, {
      sender: null,
      incomingWebhook: { name: 'CI' },
      content:
        '**Deploy** failed <script>window.hooked = true</script><img src=x onerror="window.hooked = true">',
    });
    const view = await mountChannel({ messages: page([posted]) });
    const row = view.container.querySelector<HTMLElement>(`[data-message-id="${posted.id}"]`);
    if (row === null) throw new Error('the message is not drawn');
    expect(row.getAttribute('aria-label')).toMatch(/^CI, /);
    expect(row.querySelector('[data-incoming-webhook]')?.textContent).toBe('webhook');
    expect(row.querySelector('strong')?.textContent).toBe('Deploy');
    expect(row.querySelector('script')).toBeNull();
    expect(row.querySelector('img')).toBeNull();
    expect((window as unknown as { hooked?: boolean }).hooked).toBeUndefined();
    // Not GitHub's, and nobody's to edit.
    expect(within(row).queryByText('GitHub')).toBeNull();
    view.unmountAll();
  });
});

describe('in Turkish', () => {
  test('it speaks Turkish', async () => {
    const view = await mountChannel({
      messages: page([]),
      locale: 'tr',
      api: { incomingWebhooks: () => Promise.resolve([aHook({ name: 'Dağıtım' })]) },
    });
    await person().click(view.getByRole('button', { name: 'api' }));
    await settle();
    const dialog = view.getByRole('dialog');
    await person().click(within(dialog).getByRole('tab', { name: 'Entegrasyonlar' }));
    await settle();
    const hooks = within(dialog).getByRole('region', { name: 'Gelen webhook’lar' });
    expect(within(hooks).getByText('Dağıtım')).toBeDefined();
    expect(within(hooks).getByRole('button', { name: 'Webhook oluştur' })).toBeDefined();
    view.unmountAll();
  });
});
