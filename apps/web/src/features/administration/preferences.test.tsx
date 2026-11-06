import { describe, expect, test } from 'bun:test';
import { within } from '@testing-library/react';
import { installDom } from '../../testing/dom';
import { person } from '../../testing/user';
import {
  ADMIN_PREFERENCES,
  adminError,
  adminJson,
  renderAdministration,
} from '../../testing/administration';
installDom();

describe('server identity and admission forms', () => {
  test('identity saves only identity fields, keeps confirmed values, and reports a refused change', async () => {
    let saves = 0;
    const view = await renderAdministration('overview', (call) => {
      if (call.method === 'POST' && call.path === '/api/server/preferences') {
        saves++;
        expect(call.body).toEqual({
          displayName: 'Research server',
          supportUrl: 'mailto:help@example.test',
        });
        return saves === 1 ? new Response(null, { status: 204 }) : adminError();
      }
      return undefined;
    });
    const card = within(await view.findByRole('region', { name: 'Server identity' }));
    const name = card.getByLabelText('Server display name');
    const support = card.getByLabelText('Support address');
    await person().clear(name);
    await person().type(name, '  Research server  ');
    await person().type(support, 'mailto:help@example.test');
    await person().click(card.getByRole('button', { name: 'Save settings' }));
    expect(await card.findByText('Change saved')).toBeDefined();
    expect((name as HTMLInputElement).value).toBe('Research server');
    await person().click(card.getByRole('button', { name: 'Save settings' }));
    expect(await card.findByRole('alert')).toBeDefined();
    view.unmount();
  });
  test('a name is required, domain lists are validated, and approval can be turned on and back off', async () => {
    const view = await renderAdministration('overview');
    const identity = within(await view.findByRole('region', { name: 'Server identity' }));
    await person().clear(identity.getByLabelText('Server display name'));
    await person().keyboard('{Backspace}');
    await person().click(identity.getByRole('button', { name: 'Save settings' }));
    expect(await identity.findByRole('alert')).toBeDefined();
    expect(view.calls.some((call) => call.method === 'POST')).toBe(false);
    view.unmount();
    const security = await renderAdministration('security');
    const card = within(await security.findByRole('region', { name: 'New account admission' }));
    await person().type(card.getByLabelText('Allowed email domains'), '*.example.test');
    await person().click(card.getByRole('button', { name: 'Save settings' }));
    expect(await card.findByRole('alert')).toBeDefined();
    await person().clear(card.getByLabelText('Allowed email domains'));
    await person().type(card.getByLabelText('Allowed email domains'), 'EXAMPLE.TEST, example.test');
    await person().click(card.getByRole('checkbox'));
    await person().click(card.getByRole('button', { name: 'Save settings' }));
    expect(await card.findByText('Change saved')).toBeDefined();
    expect(security.calls.find((call) => call.method === 'POST')?.body).toEqual({
      allowedEmailDomains: ['example.test'],
      requireAccountApproval: true,
    });
    await person().click(card.getByRole('checkbox'));
    await person().click(card.getByRole('button', { name: 'Save settings' }));
    expect(await card.findByText('Change saved')).toBeDefined();
    expect(security.calls.filter((call) => call.method === 'POST').at(-1)?.body).toEqual({
      allowedEmailDomains: ['example.test'],
      requireAccountApproval: false,
    });
    security.unmount();
  });
  test('clearing support removes it without altering joining rules', async () => {
    const view = await renderAdministration('overview', (call) =>
      call.path === '/api/server/preferences' && call.method === 'GET'
        ? adminJson({ ...ADMIN_PREFERENCES, supportUrl: 'https://support.example.test' })
        : undefined,
    );
    const card = within(await view.findByRole('region', { name: 'Server identity' }));
    await person().clear(card.getByLabelText('Support address'));
    await person().keyboard('{Backspace}');
    await person().click(card.getByRole('button', { name: 'Save settings' }));
    expect(await card.findByText('Change saved')).toBeDefined();
    expect(view.calls.find((call) => call.method === 'POST')?.body).toEqual({
      displayName: 'Purlay',
      supportUrl: null,
    });
    view.unmount();
  });
});
