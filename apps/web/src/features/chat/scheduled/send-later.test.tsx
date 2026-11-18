/**
 * "Send later" in the message box as a person meets it: the button and its menu, the dialog for any
 * other time, what a schedule asks of the server and what is said when it cannot be made. The world's
 * clock stands at Wednesday 2026-09-09 12:00 UTC, and the page's zone is UTC.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import {
  MESSAGE_CONTENT_MAX,
  SCHEDULED_MESSAGES_MAX,
  type Attachment,
  type MeResponse,
  type ScheduledMessage,
} from '@purlay/types';
import type { Api } from '../../../data/api';
import { ApiError } from '../../../data/errors';
import { keys } from '../../../data/keys';
import { PERSON_KEY } from '../../../data/browser-storage';
import { RealtimeProvider } from '../../../realtime/realtime-provider';
import { Toaster } from '../../../ui/toast';
import { expectNoAxeViolations } from '../../../testing/axe';
import { installDom } from '../../../testing/dom';
import { fakeSchedule } from '../../../testing/fakes';
import { IDS, WHEN, aSession, aSignedInApi } from '../../../testing/fixtures';
import { renderApp } from '../../../testing/render';
import { person } from '../../../testing/user';
import { SessionGate } from '../../session/session';
import { WorkspaceScopeProvider } from '../../shell/workspace';
import { Composer, type ComposerProps } from '../composer/composer';
import { ComposerPortsContext } from '../composer/composer-ports';
import { DRAFT_DEBOUNCE_MS, draftKey, type DraftStorage } from '../composer/drafts';
import { OutboxProvider } from '../composer/uploads';

installDom();

const ME = aSession().user.id;

const memory = (): DraftStorage & { readonly items: Map<string, string> } => {
  // The Markdown source editor, which this DOM can type into; the formatted one has its own browser suite.
  const items = new Map<string, string>([
    [PERSON_KEY, ME],
    ['purlay.composerSource', 'true'],
  ]);
  return {
    items,
    getItem: (key): string | null => items.get(key) ?? null,
    setItem: (key, value): void => {
      items.set(key, value);
    },
    removeItem: (key): void => {
      items.delete(key);
    },
    key: (index): string | null => [...items.keys()][index] ?? null,
    get length(): number {
      return items.size;
    },
  };
};

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 3; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

const scheduledMessage = (over: Partial<ScheduledMessage> = {}): ScheduledMessage => ({
  id: IDS.api,
  channelId: IDS.api,
  parentId: null,
  content: '',
  attachments: [],
  sendAt: '2026-09-10T09:00:00.000Z',
  state: 'pending',
  sentMessageId: null,
  failureCode: null,
  createdAt: WHEN,
  updatedAt: WHEN,
  ...over,
});

interface Asked {
  readonly channelId: string;
  readonly scheduledId: string;
  readonly body: Parameters<Api['scheduleMessage']>[2];
}

interface Options {
  readonly props?: Partial<ComposerProps>;
  readonly api?: Partial<Api>;
  readonly session?: MeResponse;
  readonly locale?: 'en' | 'tr';
  /** Whether the socket is open: a closed one leaves a send queued. */
  readonly open?: boolean;
  readonly draft?: string;
}

interface Mounted {
  readonly view: Awaited<ReturnType<typeof renderApp>>;
  readonly box: () => HTMLTextAreaElement;
  readonly later: () => HTMLElement;
  /** Opens the menu and presses one of its items. */
  readonly choose: (name: string | RegExp) => Promise<void>;
  readonly asked: Asked[];
  readonly storage: ReturnType<typeof memory>;
  readonly user: ReturnType<typeof person>;
  readonly timers: ReturnType<typeof fakeSchedule>;
}

const mount = async (options: Options = {}): Promise<Mounted> => {
  const asked: Asked[] = [];
  const timers = fakeSchedule();
  const storage = memory();
  if (options.draft !== undefined) storage.setItem(draftKey(ME, IDS.api, undefined), options.draft);
  const props: ComposerProps = { channelId: IDS.api, channelName: 'api', ...options.props };
  const session = options.session ?? aSession();
  const view = await renderApp(
    <SessionGate>
      <WorkspaceScopeProvider slug="acme" notFound={null}>
        <RealtimeProvider>
          <OutboxProvider>
            <ComposerPortsContext.Provider
              value={{ storage, schedule: timers.schedule, touchOnly: () => false }}
            >
              <Composer {...props} />
            </ComposerPortsContext.Provider>
          </OutboxProvider>
          <Toaster dismissLabel="Close" />
        </RealtimeProvider>
      </WorkspaceScopeProvider>
    </SessionGate>,
    {
      locale: options.locale ?? 'en',
      api: aSignedInApi({
        me: () => Promise.resolve(session),
        scheduleMessage: (channelId, scheduledId, body) => {
          asked.push({ channelId, scheduledId, body });
          return Promise.resolve(scheduledMessage({ id: scheduledId, channelId }));
        },
        ...options.api,
      }),
    },
  );
  await settle();
  if (options.open !== false) {
    act(() => {
      view.world.sockets.open();
    });
  }
  const box = (): HTMLTextAreaElement => view.getByRole('textbox') as HTMLTextAreaElement;
  const later = (): HTMLElement =>
    view.getByRole('button', { name: options.locale === 'tr' ? 'Sonra gönder' : 'Send later' });
  const user = person();
  /** Opens the menu with the pointer and presses one of its items. */
  const choose = async (name: string | RegExp): Promise<void> => {
    await user.click(later());
    await user.click(view.getByRole('menuitem', { name }));
    await settle();
  };
  return { view, box, later, choose, asked, storage, user, timers };
};

const noModules = (): MeResponse => {
  const session = aSession();
  return {
    ...session,
    modules: [],
    memberships: session.memberships.map((membership) => ({ ...membership, modules: [] })),
  };
};

describe('the button', () => {
  test('is beside Send, named, and opens a menu of times', async () => {
    const { view, later, user } = await mount();
    expect(later().getAttribute('aria-haspopup')).toBe('menu');
    await user.click(later());
    const items = view.getAllByRole('menuitem').map((item) => item.textContent);
    // Wednesday: an hour from now, tomorrow, next Monday, and any other time.
    expect(items).toEqual([
      'In 1 hour',
      'Tomorrow at 09:00',
      'Monday at 09:00',
      'Pick date and time…',
    ]);
  });

  test('is not there where the server does not hold messages for later', async () => {
    const { view } = await mount({ session: noModules() });
    expect(view.queryByRole('button', { name: 'Send later' })).toBeNull();
    expect(view.getByRole('button', { name: 'Send' })).toBeDefined();
  });

  test('opens from the keyboard and chooses with Enter', async () => {
    const { view, later, box, user, asked } = await mount();
    await user.type(box(), 'for later');
    later().focus();
    await user.keyboard('{Enter}');
    expect(view.getByRole('menu')).toBeDefined();
    await user.keyboard('{ArrowDown}{Enter}');
    await settle();
    expect(asked).toHaveLength(1);
    expect(asked[0]?.body.sendAt).toBe('2026-09-10T09:00:00.000Z');
  });

  test('has no axe violations, closed or open', async () => {
    const { view, later, user } = await mount();
    await expectNoAxeViolations(view.container);
    await user.click(later());
    await expectNoAxeViolations(view.getByRole('menu'));
  });

  test('is in Turkish, and says the time the way it is read', async () => {
    const { view, later, user } = await mount({ locale: 'tr' });
    await user.click(later());
    expect(view.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      '1 saat sonra',
      'Yarın 09:00',
      'Pazartesi 09:00',
      'Tarih ve saat seç…',
    ]);
  });
});

describe('scheduling what is in the box', () => {
  test('asks for the words at the time chosen, under an id of its own, and empties the box and its draft', async () => {
    const { view, box, user, choose, asked, storage } = await mount();
    await user.type(box(), 'ship it tomorrow');
    await choose('Tomorrow at 09:00');
    expect(asked).toHaveLength(1);
    expect(asked[0]?.channelId).toBe(IDS.api);
    expect(asked[0]?.scheduledId).toMatch(/^[0-9a-f-]{36}$/);
    expect(asked[0]?.body).toEqual({
      content: 'ship it tomorrow',
      sendAt: '2026-09-10T09:00:00.000Z',
    });
    expect(box().value).toBe('');
    expect(storage.getItem(draftKey(ME, IDS.api, undefined))).toBeNull();
    expect(view.getByText('Scheduled for Tomorrow at 09:00')).toBeDefined();
  });

  test('says when, in words, and View scheduled goes to the list', async () => {
    const { view, box, user, choose } = await mount();
    await user.type(box(), 'one hour');
    await choose('In 1 hour');
    expect(view.getByText('Scheduled for Today at 13:00')).toBeDefined();
    await user.click(view.getByRole('button', { name: 'View scheduled' }));
    expect(view.world.history.stack.at(-1)).toBe('/w/acme/drafts?tab=scheduled');
  });

  test('says it in Turkish', async () => {
    const { view, box, user, choose } = await mount({ locale: 'tr' });
    await user.type(box(), 'yarın');
    await choose('Yarın 09:00');
    expect(view.getByText('Yarın 09:00 için zamanlandı')).toBeDefined();
    expect(view.getByRole('button', { name: 'Zamanlananları gör' })).toBeDefined();
  });

  test('asks for the list to be read again', async () => {
    const { view, box, user, choose } = await mount();
    view.world.client.setQueryData(keys.scheduled(IDS.workspace, ME), []);
    await user.type(box(), 'again');
    await choose('In 1 hour');
    expect(view.world.client.getQueryState(keys.scheduled(IDS.workspace, ME))?.isInvalidated).toBe(
      true,
    );
  });

  test('a reply is scheduled under its root', async () => {
    const { box, user, choose, asked } = await mount({ props: { parentId: IDS.deploys } });
    await user.type(box(), 'answer later');
    await choose('Tomorrow at 09:00');
    expect(asked[0]?.body).toEqual({
      content: 'answer later',
      parentId: IDS.deploys,
      sendAt: '2026-09-10T09:00:00.000Z',
    });
  });

  test('is a message of the same words a send would carry: its end trimmed, a slash escaped', async () => {
    const { box, user, choose, asked } = await mount();
    await user.type(box(), '//shrug is a joke  ');
    await choose('In 1 hour');
    expect(asked[0]?.body.content).toBe('/shrug is a joke');
  });

  test('a command is not scheduled, and the words stay', async () => {
    const { view, box, user, choose, asked } = await mount();
    await user.type(box(), '/shrug');
    await choose('In 1 hour');
    expect(asked).toEqual([]);
    expect(view.getByText('A command can’t be scheduled.')).toBeDefined();
    expect(box().value).toBe('/shrug');
  });

  test('carries the files that are ready, and waits for none', async () => {
    const attachment: Attachment = {
      id: '0199155c-6200-7b7f-8c11-2a4d3f9e1b99',
      fileName: 'plan.txt',
      mimeType: 'text/plain',
      sizeBytes: 4,
      kind: 'file',
      width: null,
      height: null,
    };
    const { view, box, user, choose, asked } = await mount({
      api: { upload: () => Promise.resolve(attachment) },
    });
    await user.type(box(), 'with a file');
    const picker = view.container.querySelector('input[type="file"]');
    if (!(picker instanceof HTMLInputElement)) throw new Error('no file picker');
    await user.upload(picker, new File(['plan'], 'plan.txt', { type: 'text/plain' }));
    await settle();
    await choose('In 1 hour');
    expect(asked[0]?.body).toMatchObject({
      content: 'with a file',
      attachmentIds: [expect.any(String)],
    });
    expect(view.queryByText('plan.txt')).toBeNull();
  });

  test('a file still uploading is waited for by the person, not scheduled without', async () => {
    const { view, box, user, choose, asked } = await mount({
      api: { upload: () => new Promise<Attachment>(() => undefined) },
    });
    await user.type(box(), 'with a file');
    const picker = view.container.querySelector('input[type="file"]');
    if (!(picker instanceof HTMLInputElement)) throw new Error('no file picker');
    await user.upload(picker, new File(['plan'], 'plan.txt'));
    await choose('In 1 hour');
    expect(asked).toEqual([]);
    expect(
      view.getByText('Wait for the files to finish uploading, then schedule it.'),
    ).toBeDefined();
    expect(box().value).toBe('with a file');
  });

  test('a file that failed to upload is refused in the send’s own words', async () => {
    const { view, box, user, choose, asked } = await mount({
      api: { upload: () => Promise.reject(new ApiError(500, 'INTERNAL', 'broken')) },
    });
    await user.type(box(), 'with a file');
    const picker = view.container.querySelector('input[type="file"]');
    if (!(picker instanceof HTMLInputElement)) throw new Error('no file picker');
    await user.upload(picker, new File(['plan'], 'plan.txt'));
    await settle();
    await choose('In 1 hour');
    expect(asked).toEqual([]);
    expect(
      view.getByText(/A file did not upload/, { selector: '[role="alert"], [role="alert"] *' }),
    ).toBeDefined();
  });
});

describe('what is refused before it is asked, in the words a send uses', () => {
  test('an empty box', async () => {
    const { view, choose, asked } = await mount();
    await choose('In 1 hour');
    expect(asked).toEqual([]);
    expect(view.getByText('Write something or attach a file before scheduling it.')).toBeDefined();
  });

  test('words of only spaces', async () => {
    const { view, box, user, choose, asked } = await mount();
    await user.type(box(), '   ');
    await choose('In 1 hour');
    expect(asked).toEqual([]);
    expect(view.getByText('Write something or attach a file before scheduling it.')).toBeDefined();
  });

  test('a message over the limit, by how much', async () => {
    const { view, choose, asked } = await mount({ draft: 'a'.repeat(MESSAGE_CONTENT_MAX + 2) });
    await choose('In 1 hour');
    expect(asked).toEqual([]);
    expect(view.getByRole('alert').textContent).toContain('2');
  });

  test('a mention of everybody this channel does not allow', async () => {
    const { view, choose, asked } = await mount({ draft: 'hey @everyone' });
    await choose('In 1 hour');
    expect(asked).toEqual([]);
    expect(view.getByRole('alert').textContent).toContain('@everyone');
  });

  test('a character the contract refuses', async () => {
    const { view, choose, asked } = await mount({ draft: 'bad \u0000 character' });
    await choose('In 1 hour');
    expect(asked).toEqual([]);
    expect(view.getByRole('alert').textContent).toContain('character');
  });
});

describe('when the server does not take it', () => {
  const refuse = (code: ConstructorParameters<typeof ApiError>[1], fields = {}): Partial<Api> => ({
    scheduleMessage: () => Promise.reject(new ApiError(400, code, 'no', fields)),
  });

  test('keeps the words, the draft and the files, and says why under the box', async () => {
    const { view, box, user, choose, storage, timers } = await mount({
      api: refuse('SCHEDULED_MESSAGE_LIMIT'),
    });
    await user.type(box(), 'too many');
    await choose('In 1 hour');
    act(() => {
      timers.advance(DRAFT_DEBOUNCE_MS);
    });
    expect(box().value).toBe('too many');
    expect(view.getByRole('alert').textContent).toBe(
      `You have ${String(SCHEDULED_MESSAGES_MAX)} scheduled messages here. Cancel one to schedule another. Your message is still here.`,
    );
    expect(view.queryByText(/Scheduled for/)).toBeNull();
    expect(storage.items.has(draftKey(ME, IDS.api, undefined))).toBe(true);
  });

  test('a time the server refuses is said as a time', async () => {
    const { view, box, user, choose } = await mount({
      api: refuse('VALIDATION_FAILED', { sendAt: 'between five seconds and one year from now' }),
    });
    await user.type(box(), 'late');
    await choose('In 1 hour');
    expect(view.getByRole('alert').textContent).toContain('That time isn’t allowed.');
    expect(box().value).toBe('late');
  });

  test('no connection says that scheduling needs one, keeps the words, and Send is still there', async () => {
    const { view, box, user, choose } = await mount({
      api: refuse('NETWORK'),
    });
    await user.type(box(), 'offline words');
    await choose('In 1 hour');
    expect(view.getByRole('alert').textContent).toBe(
      'Scheduling needs a connection, and there isn’t one right now. Your message is still here.',
    );
    expect(box().value).toBe('offline words');
    expect(
      view.getByRole('button', { name: 'Send later' }).getAttribute('aria-disabled'),
    ).toBeNull();
  });

  test('asked again after a dropped connection it is the same draft; with other words, a new one', async () => {
    let answers = 0;
    const ids: string[] = [];
    const { box, user, choose } = await mount({
      api: {
        scheduleMessage: (_channelId, id) => {
          ids.push(id);
          answers += 1;
          return answers <= 3
            ? Promise.reject(new ApiError(503, 'NETWORK', 'down'))
            : Promise.resolve(scheduledMessage({ id }));
        },
      },
    });
    await user.type(box(), 'twice');
    await choose('Tomorrow at 09:00');
    await choose('Tomorrow at 09:00');
    expect(ids[1]).toBe(ids[0]);
    await choose('In 1 hour');
    expect(ids[2]).not.toBe(ids[0]);
    await user.type(box(), ' and more');
    await choose('In 1 hour');
    expect(ids[3]).not.toBe(ids[2]);
    expect(box().value).toBe('');
  });

  test('another answer is said by what it was, with the words kept', async () => {
    const { view, box, user, choose } = await mount({ api: refuse('CHANNEL_NOT_FOUND') });
    await user.type(box(), 'gone');
    await choose('In 1 hour');
    expect(view.getByRole('alert').textContent).toContain('Your message is still here.');
    expect(box().value).toBe('gone');
  });
});

describe('beside a send that is waiting for the network', () => {
  test('is never disabled by it, and schedules the words that are in the box', async () => {
    const { view, box, user, choose, asked } = await mount({ open: false });
    await user.type(box(), 'queued');
    await user.keyboard('{Enter}');
    await user.type(box(), 'and later');
    expect(view.getByRole('button', { name: 'Send later' }).hasAttribute('disabled')).toBe(false);
    await choose('In 1 hour');
    expect(asked.map((one) => one.body.content)).toEqual(['and later']);
  });
});

describe('any other time', () => {
  const pick = async (
    name = 'Pick date and time…',
  ): Promise<Mounted & { field: HTMLInputElement; type: (value: string) => Promise<void> }> => {
    const mounted = await mount();
    await mounted.user.type(mounted.box(), 'on a chosen day');
    await mounted.user.click(mounted.later());
    await mounted.user.click(mounted.view.getByRole('menuitem', { name }));
    const field = await within(document.body).findByLabelText('Date and time');
    if (!(field instanceof HTMLInputElement)) throw new Error('not an input');
    const type = async (value: string): Promise<void> => {
      await mounted.user.clear(field);
      if (value !== '') await mounted.user.type(field, value);
    };
    return { ...mounted, field, type };
  };

  test('opens on tomorrow morning in a datetime field bounded by a minute and a year', async () => {
    const { field } = await pick();
    expect(field.type).toBe('datetime-local');
    expect(field.value).toBe('2026-09-10T09:00');
    expect(field.min).toBe('2026-09-09T12:01');
    expect(field.max).toBe('2027-09-09T11:59');
  });

  test('says in place what the time will be, and schedules it on Schedule', async () => {
    const { view, field, type, user, asked } = await pick();
    await type('2026-09-12T18:30');
    expect(within(document.body).getByText('Sends Sat, Sep 12 at 18:30.')).toBeDefined();
    expect(field.getAttribute('aria-invalid')).toBeNull();
    await user.click(within(document.body).getByRole('button', { name: 'Schedule' }));
    await settle();
    expect(asked[0]?.body.sendAt).toBe('2026-09-12T18:30:00.000Z');
    expect(view.getByText('Scheduled for Sat, Sep 12 at 18:30')).toBeDefined();
    expect(within(document.body).queryByRole('dialog')).toBeNull();
  });

  test('explains a time that is past, too soon or too far, and schedules none of them', async () => {
    const { field, type, user, asked } = await pick();
    const schedule = (): HTMLElement =>
      within(document.body).getByRole('button', { name: 'Schedule' });
    const explained = (text: string): void => {
      expect(within(document.body).getByRole('alert').textContent).toBe(text);
      expect(field.getAttribute('aria-invalid')).toBe('true');
    };
    await type('2026-09-08T09:00');
    explained('Choose a time at least a minute from now.');
    await type('2026-09-09T12:00');
    explained('Choose a time at least a minute from now.');
    await type('2027-09-09T12:01');
    explained('Choose a time within the next year.');
    await user.click(schedule());
    expect(asked).toEqual([]);
    expect(within(document.body).getByRole('dialog')).toBeDefined();
  });

  test('is cancelled with Cancel, and the words stay', async () => {
    const { box, user, asked } = await pick();
    await user.click(within(document.body).getByRole('button', { name: 'Cancel' }));
    expect(within(document.body).queryByRole('dialog')).toBeNull();
    expect(box().value).toBe('on a chosen day');
    expect(asked).toEqual([]);
  });

  test('is closed with Escape, and the words stay', async () => {
    const { box, user, asked } = await pick();
    await user.keyboard('{Escape}');
    expect(within(document.body).queryByRole('dialog')).toBeNull();
    expect(box().value).toBe('on a chosen day');
    expect(asked).toEqual([]);
  });

  test('has no axe violations', async () => {
    await pick();
    await expectNoAxeViolations(within(document.body).getByRole('dialog'));
  });
});
