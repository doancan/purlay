import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import { useState } from 'react';
import type { CreatedOutgoingWebhook } from '@purlay/types';
import { OutgoingWebhooks } from './outgoing-webhooks';
import { renderApp } from '../../../testing/render';
import { anApi } from '../../../testing/fake-api';
import type { OutgoingWebhook, WebhookDeliveryPage } from '@purlay/types';
import { ApiError } from '../../../data/errors';
import { expectNoAxeViolations } from '../../../testing/axe';
import { mountChannel, page, settle, type ChannelView } from '../../../testing/channel-harness';
import { installDom } from '../../../testing/dom';
import { IDS } from '../../../testing/fixtures';
import { person } from '../../../testing/user';

installDom();
const id = '0199155c-6200-7b7f-8c11-000000000a01';
const secret = 'c'.repeat(64);
const hook: OutgoingWebhook = {
  id,
  channelId: IDS.api,
  name: 'External CI',
  url: 'https://example.com/hook',
  events: ['message.created'],
  paused: false,
  createdAt: '2026-11-14T12:00:00.000Z',
};
const open = async (view: ChannelView): Promise<HTMLElement> => {
  await person().click(view.getByRole('button', { name: 'api' }));
  await settle();
  const dialog = await view.findByRole('dialog', { name: 'Details of #api' });
  await person().click(within(dialog).getByRole('tab', { name: 'Integrations' }));
  await settle();
  return within(dialog).getByRole('region', { name: 'Outgoing webhooks' });
};
describe('outgoing channel webhook management', () => {
  test('empty state discloses content sharing and has accessible labelled controls', async () => {
    const view = await mountChannel({
      messages: page([]),
      api: { incomingWebhooks: () => Promise.resolve([]) },
    });
    const region = await open(view);
    expect(within(region).getByText('No outgoing webhooks yet')).toBeDefined();
    expect(within(region).getByText(/Message content from this channel/)).toBeDefined();
    await expectNoAxeViolations(region);
    view.unmountAll();
  });
  test('loading and failed reads preserve a retry path', async () => {
    let resolve: (value: OutgoingWebhook[]) => void = () => undefined;
    let fail = false;
    const view = await mountChannel({
      messages: page([]),
      api: {
        incomingWebhooks: () => Promise.resolve([]),
        outgoingWebhooks: () =>
          fail
            ? Promise.reject(new ApiError(500, 'INTERNAL', 'failed'))
            : new Promise((yes) => {
                resolve = yes;
              }),
      },
    });
    const region = await open(view);
    expect(within(region).getByRole('status')).toBeDefined();
    resolve([]);
    await settle();
    view.unmountAll();
    fail = true;
    const next = await mountChannel({
      messages: page([]),
      api: {
        incomingWebhooks: () => Promise.resolve([]),
        outgoingWebhooks: () => Promise.reject(new ApiError(500, 'INTERNAL', 'failed')),
      },
    });
    const error = await open(next);
    expect(within(error).getByRole('alert')).toBeDefined();
    expect(within(error).getByRole('button', { name: 'Retry' })).toBeDefined();
    next.unmountAll();
  });
  test('create sends selected events, shows secret once, and does not put it in the list', async () => {
    let hooks: OutgoingWebhook[] = [];
    let asked: unknown;
    const view = await mountChannel({
      messages: page([]),
      api: {
        incomingWebhooks: () => Promise.resolve([]),
        outgoingWebhooks: () => Promise.resolve(hooks),
        createOutgoingWebhook: (_channel, request) => {
          asked = request;
          hooks = [hook];
          return Promise.resolve({ webhook: hook, secret });
        },
      },
    });
    const region = await open(view);
    await person().type(within(region).getByLabelText('Webhook name'), 'External CI');
    await person().type(
      within(region).getByLabelText('Destination HTTPS URL'),
      'https://example.com/hook',
    );
    await person().click(within(region).getByLabelText('Thread resolved'));
    await person().click(within(region).getByRole('button', { name: 'Create outgoing webhook' }));
    await settle();
    expect(asked).toEqual({
      name: 'External CI',
      url: 'https://example.com/hook',
      events: ['message.created', 'thread.resolved'],
    });
    expect(within(region).getByText(secret)).toBeDefined();
    await person().click(within(region).getByRole('button', { name: 'Done' }));
    await settle();
    expect(within(region).queryByText(secret)).toBeNull();
    expect(within(region).getByText('https://example.com/hook')).toBeDefined();
    expect(within(region).queryByLabelText('Webhook name')).toBeNull();
    await person().click(within(region).getByRole('button', { name: 'Create outgoing webhook' }));
    await person().type(within(region).getByLabelText('Webhook name'), 'Another integration');
    await person().click(within(region).getByRole('button', { name: 'Cancel' }));
    expect(within(region).queryByLabelText('Webhook name')).toBeNull();
    await person().click(within(region).getByRole('button', { name: 'Create outgoing webhook' }));
    expect(within(region).getByLabelText<HTMLInputElement>('Webhook name').value).toBe(
      'Another integration',
    );
    view.unmountAll();
  });
  test('pause, resume, test, rotation confirmation and revoke operate on the selected hook', async () => {
    let hooks = [hook];
    const actions: string[] = [];
    const view = await mountChannel({
      messages: page([]),
      api: {
        incomingWebhooks: () => Promise.resolve([]),
        outgoingWebhooks: () => Promise.resolve(hooks),
        changeOutgoingWebhook: (_channel, _hook, action) => {
          actions.push(String(action));
          hooks = action === 'revoke' ? [] : [{ ...hook, paused: action }];
          return Promise.resolve();
        },
        rotateOutgoingWebhook: () => Promise.resolve({ webhook: hook, secret }),
        testOutgoingWebhook: () => {
          actions.push('test');
          return Promise.resolve();
        },
        webhookDeliveries: () => Promise.resolve({ data: [], nextCursor: null }),
      },
    });
    const region = await open(view);
    await person().click(within(region).getByRole('button', { name: 'Pause' }));
    await settle();
    expect(
      within(region).getByRole('button', { name: 'Send test event' }).hasAttribute('disabled'),
    ).toBe(true);
    await person().click(within(region).getByRole('button', { name: 'Resume' }));
    await settle();
    await person().click(within(region).getByRole('button', { name: 'Send test event' }));
    await settle();
    expect(within(region).getByText(/No deliveries yet/)).toBeDefined();
    await person().click(within(region).getByRole('button', { name: 'Renew secret' }));
    await settle();
    expect(within(region).getByText(/Renew the secret\?/)).toBeDefined();
    await person().click(within(region).getByRole('button', { name: 'Cancel' }));
    await settle();
    await person().click(within(region).getByRole('button', { name: 'Revoke' }));
    await settle();
    const confirmButton = within(region).getAllByRole('button', { name: 'Revoke' }).at(-1);
    if (confirmButton === undefined) throw new Error('missing confirm');
    await person().click(confirmButton);
    await settle();
    expect(actions).toEqual(['true', 'false', 'test', 'revoke']);
    expect(within(region).getByText('No outgoing webhooks yet')).toBeDefined();
    view.unmountAll();
  });
  test('delivery history shows failures and attempts and retries only failed deliveries', async () => {
    const deliveryId = '0199155c-6200-7b7f-8c11-000000000b01';
    let retries = 0;
    const deliveries: WebhookDeliveryPage = {
      data: [
        {
          id: deliveryId,
          eventId: deliveryId,
          eventType: 'message.created',
          state: 'failed',
          attemptCount: 1,
          createdAt: hook.createdAt,
          nextAttemptAt: hook.createdAt,
          lastStatus: 500,
          lastError: 'http_error',
        },
      ],
      nextCursor: null,
    };
    const view = await mountChannel({
      messages: page([]),
      api: {
        incomingWebhooks: () => Promise.resolve([]),
        outgoingWebhooks: () => Promise.resolve([hook]),
        webhookDeliveries: () => Promise.resolve(deliveries),
        webhookAttempts: () =>
          Promise.resolve([
            {
              id: deliveryId,
              attemptedAt: hook.createdAt,
              durationMs: 12,
              status: 500,
              error: 'http_error',
            },
          ]),
        retryWebhookDelivery: () => {
          retries++;
          return Promise.resolve();
        },
      },
    });
    const region = await open(view);
    await person().click(within(region).getByRole('button', { name: 'Deliveries' }));
    await settle();
    expect(within(region).getByText(/message.created · Failed/)).toBeDefined();
    await person().click(within(region).getByRole('button', { name: 'Attempts' }));
    await settle();
    expect(within(region).getByText(/12 ms/)).toBeDefined();
    await person().click(within(region).getByRole('button', { name: 'Retry' }));
    await settle();
    expect(retries).toBe(1);
    await expectNoAxeViolations(region);
    view.unmountAll();
  });
});

test('an accepted create survives a stale initial read and a failed refresh without caching the secret', async () => {
  let calls = 0;
  let release: (rows: OutgoingWebhook[]) => void = () => undefined;
  const view = await mountChannel({
    messages: page([]),
    api: {
      incomingWebhooks: () => Promise.resolve([]),
      outgoingWebhooks: () => {
        calls++;
        return calls === 1
          ? new Promise((resolve) => {
              release = resolve;
            })
          : Promise.reject(new ApiError(500, 'INTERNAL', 'refresh failed'));
      },
      createOutgoingWebhook: () => Promise.resolve({ webhook: hook, secret }),
    },
  });
  const region = await open(view);
  await person().type(within(region).getByLabelText('Webhook name'), 'External CI');
  await person().type(
    within(region).getByLabelText('Destination HTTPS URL'),
    'https://example.com/hook',
  );
  await person().click(within(region).getByRole('button', { name: 'Create outgoing webhook' }));
  await settle();
  release([]);
  await settle();
  expect(within(region).getByText('https://example.com/hook')).toBeDefined();
  expect(within(region).getByText(/Saved changes are shown/)).toBeDefined();
  await person().click(within(region).getByRole('button', { name: 'Done' }));
  await settle();
  expect(within(region).queryByText(secret)).toBeNull();
  expect(within(region).getByText('https://example.com/hook')).toBeDefined();
  view.unmountAll();
});

test('a failed list read retries to empty, and refused fields retain the entered destination', async () => {
  let reads = 0;
  const view = await mountChannel({
    messages: page([]),
    api: {
      incomingWebhooks: () => Promise.resolve([]),
      outgoingWebhooks: () =>
        ++reads === 1
          ? Promise.reject(new ApiError(500, 'INTERNAL', 'unavailable'))
          : Promise.resolve([]),
      createOutgoingWebhook: () =>
        Promise.reject(
          new ApiError(400, 'VALIDATION_FAILED', 'invalid', {
            name: 'bad',
            url: 'private',
            events: 'empty',
          }),
        ),
    },
  });
  const region = await open(view);
  await person().click(within(region).getByRole('button', { name: 'Retry' }));
  await settle();
  await person().type(within(region).getByLabelText('Webhook name'), 'CI');
  await person().type(within(region).getByLabelText('Destination HTTPS URL'), 'https://localhost');
  await person().click(within(region).getByLabelText('New message'));
  await person().click(within(region).getByRole('button', { name: 'Create outgoing webhook' }));
  await settle();
  expect(within(region).getByText('Choose at least one event.')).toBeDefined();
  expect(within(region).getByLabelText<HTMLInputElement>('Destination HTTPS URL').value).toBe(
    'https://localhost',
  );
  expect(within(region).getByText(/Use a public HTTPS address on port 443/)).toBeDefined();
  await expectNoAxeViolations(region);
  view.unmountAll();
});

test('renewed signing secrets can be copied, copy refusal is visible, and hook mutation failure retains controls', async () => {
  let failCopy = false;
  let copied = '';
  const view = await mountChannel({
    messages: page([]),
    copy: (value) => {
      if (failCopy) return Promise.reject(new Error('denied'));
      copied = value;
      return Promise.resolve();
    },
    api: {
      incomingWebhooks: () => Promise.resolve([]),
      outgoingWebhooks: () => Promise.resolve([hook]),
      changeOutgoingWebhook: () => Promise.reject(new ApiError(500, 'INTERNAL', 'failed')),
      rotateOutgoingWebhook: () => Promise.resolve({ webhook: hook, secret }),
    },
  });
  const region = await open(view);
  await person().click(within(region).getByRole('button', { name: 'Pause' }));
  await settle();
  expect(within(region).getByRole('alert')).toBeDefined();
  expect(within(region).getByRole('button', { name: 'Pause' })).toBeDefined();
  await person().click(within(region).getByRole('button', { name: 'Renew secret' }));
  await person().click(
    within(region).getAllByRole('button', { name: 'Renew secret' })[1] ??
      within(region).getByRole('button', { name: 'Renew secret' }),
  );
  await settle();
  expect(
    JSON.stringify(view.world.client.getQueryData(['outgoing-webhooks', IDS.api])),
  ).not.toContain(secret);
  await person().click(within(region).getByRole('button', { name: 'Copy' }));
  await settle();
  expect(copied).toBe(secret);
  expect(within(region).getByRole('status')).toBeDefined();
  failCopy = true;
  await person().click(within(region).getByRole('button', { name: 'Copy' }));
  await settle();
  expect(within(region).getByText(/copy/i, { selector: 'p[role="alert"]' })).toBeDefined();
  view.unmountAll();
});

test('delivery and attempt errors can be retried, failures remain visible, and older deliveries paginate', async () => {
  const deliveryId = '0199155c-6200-7b7f-8c11-000000000b01';
  let reads = 0;
  let attemptReads = 0;
  let older = false;
  const failed: WebhookDeliveryPage = {
    data: [
      {
        id: deliveryId,
        eventId: deliveryId,
        eventType: 'message.created',
        state: 'failed',
        attemptCount: 1,
        createdAt: hook.createdAt,
        nextAttemptAt: hook.createdAt,
        lastStatus: 500,
        lastError: 'http_error',
      },
    ],
    nextCursor: deliveryId,
  };
  const view = await mountChannel({
    messages: page([]),
    api: {
      incomingWebhooks: () => Promise.resolve([]),
      outgoingWebhooks: () => Promise.resolve([hook]),
      webhookDeliveries: (_channel, _hook, before) => {
        if (before !== undefined) {
          older = true;
          return Promise.resolve({ data: [], nextCursor: null });
        }
        return ++reads === 1
          ? Promise.reject(new ApiError(500, 'INTERNAL', 'unavailable'))
          : Promise.resolve(failed);
      },
      webhookAttempts: () =>
        ++attemptReads === 1
          ? Promise.reject(new ApiError(500, 'INTERNAL', 'unavailable'))
          : Promise.resolve([]),
      retryWebhookDelivery: () => Promise.reject(new ApiError(503, 'DATABASE_UNAVAILABLE', 'busy')),
    },
  });
  const region = await open(view);
  await person().click(within(region).getByRole('button', { name: 'Deliveries' }));
  await settle();
  await person().click(within(region).getByRole('button', { name: 'Retry' }));
  await settle();
  await person().click(within(region).getByRole('button', { name: 'Attempts' }));
  await settle();
  const retryButtons = within(region).getAllByRole('button', { name: 'Retry' });
  const attemptsRetry = retryButtons.at(-1);
  if (attemptsRetry === undefined) throw new Error('no attempt retry');
  await person().click(attemptsRetry);
  await settle();
  expect(within(region).getByText('No attempts yet')).toBeDefined();
  await person().click(within(region).getByRole('button', { name: 'Retry' }));
  await settle();
  expect(within(region).getByRole('alert')).toBeDefined();
  await person().click(within(region).getByRole('button', { name: 'Load older deliveries' }));
  await settle();
  expect(older).toBe(true);
  view.unmountAll();
});

const ChangingChannel = (): React.JSX.Element => {
  const [channelId, setChannelId] = useState<string>(IDS.api);
  return (
    <>
      <button
        onClick={() => {
          setChannelId(IDS.deploys);
        }}
      >
        Switch channel
      </button>
      <OutgoingWebhooks channelId={channelId} />
    </>
  );
};

test.each([false, true])(
  'channel switches clear secrets and drafts when creation is pending=%s',
  async (pending) => {
    let finish: (answer: CreatedOutgoingWebhook) => void = () => {
      throw new Error('creation not started');
    };
    const answer = { webhook: hook, secret };
    const view = await renderApp(<ChangingChannel />, {
      api: anApi({
        outgoingWebhooks: () => Promise.resolve([]),
        createOutgoingWebhook: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      }),
    });
    await settle();
    await person().type(view.getByLabelText('Webhook name', { exact: true }), 'Channel A');
    await person().type(
      view.getByLabelText('Destination HTTPS URL'),
      'https://example.com/channel-a',
    );
    await person().click(view.getByRole('button', { name: 'Create outgoing webhook' }));
    if (!pending) {
      await act(async () => {
        finish(answer);
        await Promise.resolve();
      });
      await settle();
      expect(view.getByText(secret)).toBeDefined();
    }
    await person().click(view.getByRole('button', { name: 'Switch channel' }));
    if (pending)
      await act(async () => {
        finish(answer);
        await Promise.resolve();
      });
    await settle();
    expect(view.queryByText(secret)).toBeNull();
    expect(view.queryByRole('heading', { name: 'Signing secret' })).toBeNull();
    expect((view.getByLabelText('Webhook name', { exact: true }) as HTMLInputElement).value).toBe(
      '',
    );
    expect((view.getByLabelText('Destination HTTPS URL') as HTMLInputElement).value).toBe('');
    expect(
      JSON.stringify(view.world.client.getQueryData(['outgoing-webhooks', IDS.deploys])),
    ).not.toContain(hook.id);
    view.unmount();
  },
);
