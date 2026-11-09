import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import { installDom } from '../../testing/dom';
import { person } from '../../testing/user';
import { expectNoAxeViolations } from '../../testing/axe';
import { adminError, adminJson, renderAdministration } from '../../testing/administration';
installDom();
const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

describe('server browser notification settings', () => {
  test('first enable generates server keys, toggling keeps them, and changes send only an enabled flag', async () => {
    let enabled = false;
    let keysCreated = false;
    const writes: unknown[] = [];
    const view = await renderAdministration('email', (call) => {
      if (call.path !== '/api/server/push') return undefined;
      if (call.method === 'PUT') {
        writes.push(call.body);
        enabled = (call.body as { enabled: boolean }).enabled;
        keysCreated = true;
      }
      return adminJson({
        enabled,
        keysCreated,
        subject: keysCreated ? 'https://purlay.test' : null,
      });
    });
    const card = within(await view.findByRole('region', { name: 'Browser notifications' }));
    expect(
      await card.findByText('Closed-tab notifications are disabled on the server.'),
    ).toBeDefined();
    expect(card.getByText('Enabling generates the server keys automatically.')).toBeDefined();
    await person().click(card.getByRole('button', { name: 'Enable on this server' }));
    expect(
      await card.findByText('Closed-tab notifications are enabled on the server.'),
    ).toBeDefined();
    await settle();
    await person().click(card.getByRole('button', { name: 'Disable on this server' }));
    expect(
      await card.findByText('Closed-tab notifications are disabled on the server.'),
    ).toBeDefined();
    expect(card.getByText(/existing keys and device registrations are kept/)).toBeDefined();
    expect(writes).toEqual([{ enabled: true }, { enabled: false }]);
    expect(card.getByText(/Each person must enable notifications in their browser/)).toBeDefined();
    await expectNoAxeViolations(view.container);
    view.unmount();
  });

  test('a failed refresh preserves an accepted setting and offers a read-only retry', async () => {
    let enabled = false;
    let failRead = false;
    let writes = 0;
    const view = await renderAdministration('email', (call) => {
      if (call.path !== '/api/server/push') return undefined;
      if (call.method === 'PUT') {
        enabled = true;
        failRead = true;
        writes++;
      } else if (failRead) return adminError();
      return adminJson({
        enabled,
        keysCreated: enabled,
        subject: enabled ? 'https://purlay.test' : null,
      });
    });
    const card = within(await view.findByRole('region', { name: 'Browser notifications' }));
    await person().click(await card.findByRole('button', { name: 'Enable on this server' }));
    expect(
      await card.findByText('The refresh failed. The last received data is shown below.'),
    ).toBeDefined();
    expect(card.getByText('Closed-tab notifications are enabled on the server.')).toBeDefined();
    expect(
      card.getByRole('button', { name: 'Disable on this server' }).hasAttribute('disabled'),
    ).toBe(true);
    failRead = false;
    await person().click(card.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(writes).toBe(1);
    expect(
      card.queryByText('The refresh failed. The last received data is shown below.'),
    ).toBeNull();
    expect(
      card.getByRole('button', { name: 'Disable on this server' }).hasAttribute('disabled'),
    ).toBe(false);
    view.unmount();
  });

  test('a rejected change retains the old state and is retryable; unavailable settings do not offer a toggle', async () => {
    let fail = true;
    const view = await renderAdministration('email', (call) => {
      if (call.path !== '/api/server/push') return undefined;
      if (call.method === 'PUT' && fail) return adminError();
      return adminJson({ enabled: call.method === 'PUT', keysCreated: false, subject: null });
    });
    const card = within(await view.findByRole('region', { name: 'Browser notifications' }));
    await person().click(await card.findByRole('button', { name: 'Enable on this server' }));
    await settle();
    expect(card.getByText('Closed-tab notifications are disabled on the server.')).toBeDefined();
    expect(
      card.getByRole('button', { name: 'Enable on this server' }).hasAttribute('disabled'),
    ).toBe(false);
    fail = false;
    view.unmount();
    const failed = await renderAdministration('email', (call) =>
      call.path === '/api/server/push' ? adminError() : undefined,
    );
    const unavailable = within(
      await failed.findByRole('region', { name: 'Browser notifications' }),
    );
    expect(await unavailable.findByRole('button', { name: 'Retry' })).toBeDefined();
    expect(unavailable.queryByRole('button', { name: 'Enable on this server' })).toBeNull();
    failed.unmount();
  });
});
