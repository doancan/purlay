import { describe, expect, test } from 'bun:test';
import { act, fireEvent, within } from '@testing-library/react';
import type { ServerModuleStatus } from '@purlay/types';
import { installDom } from '../../testing/dom';
import { person } from '../../testing/user';
import { expectNoAxeViolations } from '../../testing/axe';
import {
  ADMIN_STAMP,
  adminError,
  adminJson,
  renderAdministration,
  type AdministrationCall,
} from '../../testing/administration';
installDom();
const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const status = (over: Partial<ServerModuleStatus> & { module: string }): ServerModuleStatus => ({
  running: true,
  state: 'active',
  reason: null,
  suspendedAt: null,
  suspendedBy: null,
  stopsWith: [],
  stopNeedsForce: false,
  ...over,
});
const CHAT = status({ module: 'chat', stopNeedsForce: true });
const ISSUES = status({ module: 'issues', stopsWith: ['tasks'] });
const TASKS = status({ module: 'tasks' });
const STOPPED_ISSUES = status({
  module: 'issues',
  state: 'suspended',
  reason: 'leaks rows between tickets',
  suspendedAt: ADMIN_STAMP,
  suspendedBy: '00000000-0000-4000-8000-0000000000e1',
});
const BLOCKED_TASKS = status({ module: 'tasks', state: 'blocked' });

const isList = (call: AdministrationCall): boolean =>
  call.method === 'GET' && call.path === '/api/server/modules';
const isWrite = (call: AdministrationCall): boolean =>
  call.method === 'POST' && /^\/api\/server\/modules\/[a-z-]+\/suspension$/.test(call.path);

/** A server whose stops are the ones written through it, answering as the route does. */
const serverOf = (
  refuse: (call: AdministrationCall) => Response | undefined = () => undefined,
): {
  answer: (call: AdministrationCall) => Response | undefined;
  writes: AdministrationCall[];
} => {
  let stopped = false;
  const writes: AdministrationCall[] = [];
  return {
    writes,
    answer: (call): Response | undefined => {
      if (isList(call))
        return adminJson({
          data: stopped ? [CHAT, STOPPED_ISSUES, BLOCKED_TASKS] : [CHAT, ISSUES, TASKS],
        });
      if (!isWrite(call)) return undefined;
      writes.push(call);
      const refused = refuse(call);
      if (refused !== undefined) return refused;
      const body = call.body as { state: 'suspended' | 'running' };
      const changed = (body.state === 'suspended') !== stopped;
      stopped = body.state === 'suspended';
      return adminJson({
        module: 'issues',
        state: body.state,
        changed,
        alsoAffected: changed ? ['tasks'] : [],
      });
    },
  };
};

describe('stopping and resuming a module (D-296, D-323)', () => {
  test('lists each module with its state, what a stop takes with it, and the stop’s reason', async () => {
    const server = serverOf();
    const view = await renderAdministration('modules', server.answer);
    const issues = within(await view.findByRole('region', { name: 'issues' }));
    expect(issues.getByText('Running')).toBeDefined();
    expect(issues.getByText('tasks')).toBeDefined();
    expect(
      within(view.getByRole('region', { name: 'tasks' })).getByText('Nothing else'),
    ).toBeDefined();
    expect(view.getByRole('heading', { level: 1, name: 'Modules' })).toBeDefined();
    await expectNoAxeViolations(view.container);
    view.unmount();
  });

  test('a stop needs a reason, says what stops with it, and then says what it came to', async () => {
    const server = serverOf((call) =>
      (call.body as { reason?: string }).reason === ''
        ? adminJson(
            {
              error: {
                code: 'VALIDATION_FAILED',
                message: 'The stop is not valid.',
                details: { fields: { reason: 'Is needed to stop a module.' } },
              },
            },
            400,
          )
        : undefined,
    );
    const view = await renderAdministration('modules', server.answer);
    const issues = within(await view.findByRole('region', { name: 'issues' }));
    await person().click(issues.getByRole('button', { name: 'Stop…' }));
    const dialog = within(view.getByRole('dialog', { name: 'Stop issues' }));
    expect(dialog.getByText('Also stops, because it requires this one: tasks')).toBeDefined();
    // Not a schema copied into the client: the server refuses, and the field says so.
    await person().click(dialog.getByRole('button', { name: 'Stop module' }));
    expect(await dialog.findByText('Say why you are stopping it.')).toBeDefined();
    expect(dialog.getByLabelText('Reason').getAttribute('aria-invalid')).toBe('true');
    await person().type(dialog.getByLabelText('Reason'), 'Kayıtlar arası sızıntı — <b>öğrenci</b>');
    await person().click(dialog.getByRole('button', { name: 'Stop module' }));
    await settle();
    expect(view.queryByRole('dialog')).toBeNull();
    expect(server.writes.map((call) => call.body)).toEqual([
      { state: 'suspended', reason: '' },
      { state: 'suspended', reason: 'Kayıtlar arası sızıntı — <b>öğrenci</b>' },
    ]);
    expect(server.writes[1]?.path).toBe('/api/server/modules/issues/suspension');
    expect(
      await view.findByText(
        'issues is stopped. Every node stops serving it within two seconds. Stopped with it: tasks.',
      ),
    ).toBeDefined();
    // The list is read again: the stop and its reason, and the module out because of it.
    const stopped = within(await view.findByRole('region', { name: 'issues' }));
    expect(await stopped.findByText('Stopped for every workspace')).toBeDefined();
    expect(stopped.getByText('leaks rows between tickets')).toBeDefined();
    expect(
      within(view.getByRole('region', { name: 'tasks' })).getByText(
        'Out of service: a module it requires is stopped',
      ),
    ).toBeDefined();
    expect(within(view.getByRole('region', { name: 'tasks' })).queryByRole('button')).toBeNull();
    view.unmount();
  });

  test('a stop that takes the product down is sent only once it is meant, with force', async () => {
    const server = serverOf();
    const view = await renderAdministration('modules', server.answer);
    const chat = within(await view.findByRole('region', { name: 'chat' }));
    await person().click(chat.getByRole('button', { name: 'Stop…' }));
    const dialog = within(view.getByRole('dialog', { name: 'Stop chat' }));
    await person().type(dialog.getByLabelText('Reason'), 'incident');
    const stop = dialog.getByRole('button', { name: 'Stop module' });
    expect(stop.hasAttribute('disabled')).toBe(true);
    // Enter in the reason field submits the form, as a browser does with one text field.
    const form = dialog.getByLabelText('Reason').closest('form');
    if (form === null) throw new Error('the stop has no form');
    fireEvent.submit(form);
    await settle();
    expect(server.writes).toEqual([]);
    await person().click(
      dialog.getByRole('checkbox', {
        name: 'Stopping chat takes the product down for every workspace. I mean it.',
      }),
    );
    await person().click(stop);
    await settle();
    expect(server.writes.map((call) => call.body)).toEqual([
      { state: 'suspended', reason: 'incident', force: true },
    ]);
    view.unmount();
  });

  test('a refusal for force the list did not foresee asks for the confirmation there and then', async () => {
    const server = serverOf((call) =>
      (call.body as { force?: boolean }).force === true
        ? undefined
        : adminJson(
            {
              error: {
                code: 'VALIDATION_FAILED',
                message: 'The stop is not valid.',
                details: { fields: { force: 'Stopping issues takes chat down.' } },
              },
            },
            400,
          ),
    );
    const view = await renderAdministration('modules', server.answer);
    await person().click(
      within(await view.findByRole('region', { name: 'issues' })).getByRole('button', {
        name: 'Stop…',
      }),
    );
    const dialog = within(view.getByRole('dialog'));
    await person().type(dialog.getByLabelText('Reason'), 'incident');
    await person().click(dialog.getByRole('button', { name: 'Stop module' }));
    const confirm = await dialog.findByRole('checkbox');
    await person().click(confirm);
    await person().click(dialog.getByRole('button', { name: 'Stop module' }));
    await settle();
    expect(server.writes.map((call) => call.body)).toEqual([
      { state: 'suspended', reason: 'incident' },
      { state: 'suspended', reason: 'incident', force: true },
    ]);
    view.unmount();
  });

  test('a cluster not ready for the stop is said plainly, and nothing is closed', async () => {
    const server = serverOf(() =>
      adminJson(
        {
          error: {
            code: 'PEERS_BEHIND',
            message: '1 node(s) of this cluster do not read the stopped modules yet.',
          },
        },
        409,
      ),
    );
    const view = await renderAdministration('modules', server.answer);
    await person().click(
      within(await view.findByRole('region', { name: 'issues' })).getByRole('button', {
        name: 'Stop…',
      }),
    );
    const dialog = within(view.getByRole('dialog'));
    await person().type(dialog.getByLabelText('Reason'), 'incident');
    await person().click(dialog.getByRole('button', { name: 'Stop module' }));
    expect(
      await dialog.findByText(
        'A node of this cluster does not read stopped modules yet, so it would go on serving issues. Finish the rollout, then stop it.',
      ),
    ).toBeDefined();
    expect(view.getByRole('dialog')).toBeDefined();
    expect(dialog.getByLabelText('Reason')).toHaveProperty('value', 'incident');
    view.unmount();
  });

  test('a stopped module runs again from its card, and a repeat says nothing changed', async () => {
    const server = serverOf();
    const view = await renderAdministration('modules', server.answer);
    await person().click(
      within(await view.findByRole('region', { name: 'issues' })).getByRole('button', {
        name: 'Stop…',
      }),
    );
    const dialog = within(view.getByRole('dialog'));
    await person().type(dialog.getByLabelText('Reason'), 'incident');
    await person().click(dialog.getByRole('button', { name: 'Stop module' }));
    const stopped = within(await view.findByRole('region', { name: 'issues' }));
    await person().click(await stopped.findByRole('button', { name: 'Let it run again' }));
    expect(
      await view.findByText('issues is running again. Running again with it: tasks.'),
    ).toBeDefined();
    expect(server.writes.at(-1)?.body).toEqual({ state: 'running' });
    view.unmount();
  });

  test('a failed resume is said on the card, and the stop stays', async () => {
    const view = await renderAdministration('modules', (call) =>
      isList(call)
        ? adminJson({ data: [CHAT, STOPPED_ISSUES, BLOCKED_TASKS] })
        : isWrite(call)
          ? adminError()
          : undefined,
    );
    const issues = within(await view.findByRole('region', { name: 'issues' }));
    await person().click(issues.getByRole('button', { name: 'Let it run again' }));
    expect(await issues.findByRole('alert')).toBeDefined();
    expect(issues.getByText('Stopped for every workspace')).toBeDefined();
    view.unmount();
  });

  test('loading, a failed read with Retry, and a build with no module are each said', async () => {
    const hold = Promise.withResolvers<Response>();
    const loading = await renderAdministration('modules', (call) =>
      isList(call) ? hold.promise : undefined,
    );
    expect(await loading.findByText('Loading')).toBeDefined();
    expect(loading.queryByRole('region', { name: 'chat' })).toBeNull();
    hold.resolve(adminJson({ data: [CHAT] }));
    expect(await loading.findByRole('region', { name: 'chat' })).toBeDefined();
    loading.unmount();
    let reads = 0;
    const view = await renderAdministration('modules', (call) => {
      if (!isList(call)) return undefined;
      reads++;
      return reads === 1 ? adminError() : adminJson({ data: [] });
    });
    expect(await view.findByText('Could not read administration data')).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Retry' }));
    expect(await view.findByText('This server carries no modules')).toBeDefined();
    view.unmount();
  });
});
