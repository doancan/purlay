/**
 * "Remind me…" on a message, as a person meets it in a channel: the presets and the date dialog in
 * their own time zone, the mark a message with a reminder carries, painted at once, put back and said
 * when the server refuses. The fake clock is the feed's: 2026-09-09 12:00 UTC, and the page is in UTC.
 */
import { describe, expect, test } from 'bun:test';
import { act, waitFor, within } from '@testing-library/react';
import type { MessageReminder } from '@purlay/types';
import { ApiError } from '../../../data/errors';
import { keys } from '../../../data/keys';
import { expectNoAxeViolations } from '../../../testing/axe';
import { mountChannel, page, settle } from '../../../testing/channel-harness';
import { createFormatters } from '../../../i18n/format';
import { installDom } from '../../../testing/dom';
import { IDS, aMessage, aSession, aSignedInApi } from '../../../testing/fixtures';
import { renderApp } from '../../../testing/render';
import { SessionGate } from '../../session/session';
import { WorkspaceScopeProvider } from '../../shell/workspace';
import { useReminderActions, useRemindersAvailable } from './use-reminders';
import { person } from '../../../testing/user';

installDom();

/** A time as the page says it: the ICU of the machine decides how, so a test asks the same formatter. */
const when = (iso: string): string => createFormatters('en', 'UTC').absolute(iso);

const first = aMessage(1, { content: 'remember this one' });
const second = aMessage(2, { content: 'and not this one' });

const reminderOn = (message: typeof first, remindAt: string): MessageReminder => ({
  id: `0199155c-7000-7b7f-8c11-${message.id.slice(-12)}`,
  message,
  remindAt,
  createdAt: '2026-09-09T11:00:00.000Z',
});

/** A server whose list is what was set and cancelled, answering when the test lets it. */
const aServer = (
  held: MessageReminder[] = [],
): {
  held: MessageReminder[];
  readonly set: string[];
  readonly cancelled: string[];
  readonly api: {
    readonly listReminders: () => Promise<MessageReminder[]>;
    readonly setMessageReminder: (id: string, at: string) => Promise<MessageReminder>;
    readonly cancelMessageReminder: (id: string) => Promise<void>;
  };
} => {
  const server = {
    held,
    set: [] as string[],
    cancelled: [] as string[],
    api: {
      listReminders: (): Promise<MessageReminder[]> => Promise.resolve([...server.held]),
      setMessageReminder: (id: string, at: string): Promise<MessageReminder> => {
        server.set.push(`${id} ${at}`);
        const message = [first, second].find((one) => one.id === id) ?? first;
        const reminder = reminderOn(message, at);
        server.held = [...server.held.filter((one) => one.message.id !== id), reminder];
        return Promise.resolve(reminder);
      },
      cancelMessageReminder: (id: string): Promise<void> => {
        server.cancelled.push(id);
        server.held = server.held.filter((one) => one.message.id !== id);
        return Promise.resolve();
      },
    },
  };
  return server;
};

type View = Awaited<ReturnType<typeof mountChannel>>;

const rowOf = (view: View, text: string): HTMLElement => {
  const row = [...view.container.querySelectorAll<HTMLElement>('[data-message-id]')].find((each) =>
    each.textContent.includes(text),
  );
  if (row === undefined) throw new Error(`no row says ${text}`);
  return row;
};

/** Opens a message's More menu and its reminder entry, the way a pointer does. */
const openReminder = async (view: View, text: string, name: string | RegExp): Promise<void> => {
  await person().click(within(rowOf(view, text)).getByRole('button', { name: 'More' }));
  await person().click(view.getByRole('menuitem', { name }));
};

const markOf = (view: View, text: string): HTMLElement | null =>
  rowOf(view, text).querySelector<HTMLElement>('[data-reminder-mark]');

describe('a message with no reminder', () => {
  test('offers the presets, worked out on the viewer’s clock, and sets the one chosen', async () => {
    const server = aServer();
    const view = await mountChannel({ messages: page([first, second]), api: server.api });
    try {
      await openReminder(view, 'remember this one', 'Remind me…');
      for (const name of [
        'In 20 minutes',
        'In 1 hour',
        'In 3 hours',
        'Tomorrow at 09:00',
        'Next Monday at 09:00',
        'Pick date and time…',
      ])
        expect(view.getByRole('menuitem', { name })).toBeDefined();
      await person().click(view.getByRole('menuitem', { name: 'In 1 hour' }));
      await settle();
      expect(server.set).toEqual([`${first.id} 2026-09-09T13:00:00.000Z`]);
      expect(markOf(view, 'remember this one')?.textContent).toBe(
        `Reminder: ${when('2026-09-09T13:00:00Z')}`,
      );
      expect(markOf(view, 'and not this one')).toBeNull();
      expect(view.getByText(`Reminder set for ${when('2026-09-09T13:00:00Z')}.`)).toBeDefined();
    } finally {
      view.unmountAll();
    }
  });

  test('tomorrow and next Monday are 09:00 on the viewer’s wall', async () => {
    const server = aServer();
    const view = await mountChannel({ messages: page([first]), api: server.api });
    try {
      await openReminder(view, 'remember this one', 'Remind me…');
      await person().click(view.getByRole('menuitem', { name: 'Next Monday at 09:00' }));
      await settle();
      // 2026-09-09 is a Wednesday.
      expect(server.set).toEqual([`${first.id} 2026-09-14T09:00:00.000Z`]);
    } finally {
      view.unmountAll();
    }
  });

  test('the mark is painted before the server answers, and taken back, and said, when it refuses', async () => {
    const answer = Promise.withResolvers<MessageReminder>();
    const view = await mountChannel({
      messages: page([first]),
      api: {
        listReminders: () => Promise.resolve([]),
        setMessageReminder: () => answer.promise,
      },
    });
    try {
      await openReminder(view, 'remember this one', 'Remind me…');
      await person().click(view.getByRole('menuitem', { name: 'In 3 hours' }));
      await settle();
      expect(markOf(view, 'remember this one')?.textContent).toBe(
        `Reminder: ${when('2026-09-09T15:00:00Z')}`,
      );
      answer.reject(new ApiError(403, 'FORBIDDEN', 'No'));
      await settle();
      expect(markOf(view, 'remember this one')).toBeNull();
      expect(view.getByText(/^The reminder was not set\./)).toBeDefined();
    } finally {
      view.unmountAll();
    }
  });

  test('a refusal that could be a passing fault offers Retry', async () => {
    const server = aServer();
    let tries = 0;
    const view = await mountChannel({
      messages: page([first]),
      api: {
        ...server.api,
        setMessageReminder: (id, at) => {
          tries++;
          return tries === 1
            ? Promise.reject(new ApiError(0, 'NETWORK', 'down'))
            : server.api.setMessageReminder(id, at);
        },
      },
    });
    try {
      await openReminder(view, 'remember this one', 'Remind me…');
      await person().click(view.getByRole('menuitem', { name: 'In 1 hour' }));
      await settle();
      expect(markOf(view, 'remember this one')).toBeNull();
      await person().click(view.getByRole('button', { name: 'Retry' }));
      await settle();
      expect(tries).toBe(2);
      expect(markOf(view, 'remember this one')).not.toBeNull();
    } finally {
      view.unmountAll();
    }
  });
});

describe('a message that has a reminder', () => {
  const held = (): MessageReminder[] => [reminderOn(first, '2026-09-10T08:30:00.000Z')];

  test('says when, in its mark and in its menu, and offers Change… and Remove reminder', async () => {
    const server = aServer(held());
    const view = await mountChannel({ messages: page([first, second]), api: server.api });
    try {
      await settle();
      expect(markOf(view, 'remember this one')?.textContent).toBe(
        `Reminder: ${when('2026-09-10T08:30:00Z')}`,
      );
      expect(markOf(view, 'remember this one')?.getAttribute('title')).toBe(
        `Reminder: ${when('2026-09-10T08:30:00Z')}`,
      );
      await openReminder(view, 'remember this one', `Reminder: ${when('2026-09-10T08:30:00Z')}`);
      expect(view.getByRole('menuitem', { name: 'Change…' })).toBeDefined();
      expect(view.getByRole('menuitem', { name: 'Remove reminder' })).toBeDefined();
      expect(view.queryByRole('menuitem', { name: 'In 1 hour' })).toBeNull();
    } finally {
      view.unmountAll();
    }
  });

  test('Remove reminder takes the mark away at once and asks the server', async () => {
    const server = aServer(held());
    const view = await mountChannel({ messages: page([first]), api: server.api });
    try {
      await settle();
      await openReminder(view, 'remember this one', /^Reminder: /);
      await person().click(view.getByRole('menuitem', { name: 'Remove reminder' }));
      await settle();
      expect(server.cancelled).toEqual([first.id]);
      expect(markOf(view, 'remember this one')).toBeNull();
    } finally {
      view.unmountAll();
    }
  });

  test('a removal the server refuses puts the mark back and says what failed', async () => {
    const view = await mountChannel({
      messages: page([first, second]),
      api: {
        listReminders: () =>
          Promise.resolve([...held(), reminderOn(second, '2026-09-11T08:00:00.000Z')]),
        cancelMessageReminder: () => Promise.reject(new ApiError(403, 'FORBIDDEN', 'No')),
      },
    });
    try {
      await settle();
      await openReminder(view, 'remember this one', /^Reminder: /);
      await person().click(view.getByRole('menuitem', { name: 'Remove reminder' }));
      await settle();
      expect(markOf(view, 'remember this one')).not.toBeNull();
      // Another message's reminder was never touched.
      expect(markOf(view, 'and not this one')).not.toBeNull();
      expect(view.getByText(/^The reminder was not removed\./)).toBeDefined();
    } finally {
      view.unmountAll();
    }
  });

  test('a list read while the change is on its way cannot paint the old mark back', async () => {
    const answer = Promise.withResolvers<undefined>();
    const view = await mountChannel({
      messages: page([first]),
      api: {
        listReminders: () => Promise.resolve(held()),
        cancelMessageReminder: () => answer.promise,
      },
    });
    try {
      await settle();
      await openReminder(view, 'remember this one', /^Reminder: /);
      await person().click(view.getByRole('menuitem', { name: 'Remove reminder' }));
      await settle();
      expect(markOf(view, 'remember this one')).toBeNull();
      answer.resolve(undefined);
    } finally {
      view.unmountAll();
    }
  });

  test('a frame from another device reads the list again and the mark follows', async () => {
    const server = aServer();
    const view = await mountChannel({ messages: page([first]), api: server.api });
    try {
      await settle();
      expect(markOf(view, 'remember this one')).toBeNull();
      server.held = held();
      await act(async () => {
        await view.world.client.invalidateQueries({ queryKey: keys.reminders(IDS.workspace) });
      });
      await waitFor(() => {
        expect(markOf(view, 'remember this one')).not.toBeNull();
      });
    } finally {
      view.unmountAll();
    }
  });
});

describe('Pick date and time…', () => {
  const field = (view: View): HTMLInputElement => {
    const input = view.getByLabelText('Remind me at');
    if (!(input instanceof HTMLInputElement)) throw new Error('not an input');
    return input;
  };

  test('asks in the viewer’s zone, with bounds, and explains a time that will not do in place', async () => {
    const server = aServer();
    const view = await mountChannel({ messages: page([first]), api: server.api });
    try {
      await openReminder(view, 'remember this one', 'Remind me…');
      await person().click(view.getByRole('menuitem', { name: 'Pick date and time…' }));
      const dialog = await view.findByRole('dialog', { name: 'Remind me about this message' });
      const input = within(dialog).getByLabelText('Remind me at');
      expect(input.getAttribute('type')).toBe('datetime-local');
      expect(input.getAttribute('min')).toBe('2026-09-09T12:01');
      expect(input.getAttribute('max')).toBe('2027-09-09T11:59');
      // Tomorrow morning is what it starts on.
      expect(field(view).value).toBe('2026-09-10T09:00');
      await expectNoAxeViolations(dialog);

      await person().clear(input);
      await person().type(input, '2026-09-09T11:00');
      await person().click(within(dialog).getByRole('button', { name: 'Set reminder' }));
      expect(within(dialog).getByRole('alert').textContent).toBe(
        'Choose a time at least a minute from now.',
      );
      expect(input.getAttribute('aria-invalid')).toBe('true');

      await person().clear(input);
      await person().type(input, '2028-01-01T10:00');
      await person().click(within(dialog).getByRole('button', { name: 'Set reminder' }));
      expect(within(dialog).getByRole('alert').textContent).toBe(
        'Choose a time within the next year.',
      );
      expect(server.set).toEqual([]);

      await person().clear(input);
      await person().type(input, '2026-09-12T18:45');
      await person().click(within(dialog).getByRole('button', { name: 'Set reminder' }));
      await settle();
      expect(server.set).toEqual([`${first.id} 2026-09-12T18:45:00.000Z`]);
      expect(view.queryByRole('dialog')).toBeNull();
    } finally {
      view.unmountAll();
    }
  });

  test('Change… starts on the reminder the message has, and replaces it', async () => {
    const server = aServer([reminderOn(first, '2026-09-10T08:30:00.000Z')]);
    const view = await mountChannel({ messages: page([first]), api: server.api });
    try {
      await settle();
      await openReminder(view, 'remember this one', /^Reminder: /);
      await person().click(view.getByRole('menuitem', { name: 'Change…' }));
      const dialog = await view.findByRole('dialog', { name: 'Remind me about this message' });
      expect(field(view).value).toBe('2026-09-10T08:30');
      await person().clear(field(view));
      await person().type(field(view), '2026-09-11T07:15');
      await person().click(within(dialog).getByRole('button', { name: 'Save' }));
      await settle();
      expect(server.set).toEqual([`${first.id} 2026-09-11T07:15:00.000Z`]);
      expect(markOf(view, 'remember this one')?.textContent).toBe(
        `Reminder: ${when('2026-09-11T07:15:00Z')}`,
      );
    } finally {
      view.unmountAll();
    }
  });

  test('Escape closes it and sets nothing', async () => {
    const server = aServer();
    const view = await mountChannel({ messages: page([first]), api: server.api });
    try {
      await openReminder(view, 'remember this one', 'Remind me…');
      await person().click(view.getByRole('menuitem', { name: 'Pick date and time…' }));
      await view.findByRole('dialog', { name: 'Remind me about this message' });
      await person().keyboard('{Escape}');
      await waitFor(() => {
        expect(view.queryByRole('dialog')).toBeNull();
      });
      expect(server.set).toEqual([]);
    } finally {
      view.unmountAll();
    }
  });
});

describe('in Turkish', () => {
  test('the menu, the presets and the mark are in the language', async () => {
    const server = aServer([reminderOn(first, '2026-09-10T08:30:00.000Z')]);
    const view = await mountChannel({
      messages: page([first, second]),
      locale: 'tr',
      api: server.api,
    });
    try {
      await settle();
      expect(markOf(view, 'remember this one')?.textContent).toMatch(/^Hatırlatma: /);
      await person().click(
        within(rowOf(view, 'and not this one')).getByRole('button', { name: 'Daha fazla' }),
      );
      await person().click(view.getByRole('menuitem', { name: 'Bana hatırlat…' }));
      expect(view.getByRole('menuitem', { name: '20 dakika sonra' })).toBeDefined();
      expect(view.getByRole('menuitem', { name: 'Gelecek pazartesi saat 09:00’da' })).toBeDefined();
      expect(view.getByRole('menuitem', { name: 'Tarih ve saat seç…' })).toBeDefined();
    } finally {
      view.unmountAll();
    }
  });
});

describe('where the server does not remind', () => {
  const Probe = (): React.JSX.Element => (
    <p>{`${useRemindersAvailable() ? 'available' : 'unavailable'} ${useReminderActions() === null ? 'no actions' : 'actions'}`}</p>
  );

  const inWorkspaceWith = async (
    modules: readonly ('chat' | 'issues')[],
  ): Promise<string | null> => {
    const session = aSession();
    const [membership] = session.memberships;
    const view = await renderApp(
      <SessionGate>
        <WorkspaceScopeProvider slug="acme" notFound={null}>
          <Probe />
        </WorkspaceScopeProvider>
      </SessionGate>,
      {
        api: aSignedInApi({
          me: () =>
            Promise.resolve({
              ...session,
              memberships:
                membership === undefined ? [] : [{ ...membership, modules: [...modules] }],
            }),
        }),
      },
    );
    await settle();
    const said = view.container.querySelector('p')?.textContent ?? null;
    view.unmount();
    return said;
  };

  test('a workspace that runs chat can remind; one that does not, cannot, and nothing is drawn', async () => {
    expect(await inWorkspaceWith(['chat'])).toBe('available actions');
    expect(await inWorkspaceWith(['issues'])).toBe('unavailable no actions');
  });

  test('a row with no session or workspace to ask has no reminders, and does not fail', async () => {
    const view = await renderApp(<Probe />);
    expect(view.container.querySelector('p')?.textContent).toBe('unavailable no actions');
    view.unmount();
  });
});
