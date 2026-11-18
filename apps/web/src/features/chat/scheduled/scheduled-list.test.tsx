/**
 * The Scheduled tab of Drafts and sent as a person meets it: what is waiting and when, what failed and
 * why, cancelling with Undo, editing back into the draft, and the list being read again when the tab
 * opens and the window is focused. The world's clock stands at Wednesday 2026-09-09 12:00 UTC.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { Attachment, MeResponse, ScheduledMessage } from '@purlay/types';
import { Outlet } from '../../../app/outlet';
import type { Api } from '../../../data/api';
import { ApiError } from '../../../data/errors';
import { installDom } from '../../../testing/dom';
import { memoryStorage } from '../../../testing/fakes';
import { IDS, WHEN, aSession, aSignedInApi } from '../../../testing/fixtures';
import { renderApp } from '../../../testing/render';
import { settle } from '../../../testing/channel-harness';
import { person } from '../../../testing/user';
import { Toaster } from '../../../ui/toast';
import { ComposerPortsContext } from '../composer/composer-ports';
import { draftKey } from '../composer/drafts';

installDom();

const ME = aSession().user.id;
const ROOT = '0199155c-6200-7b7f-8c11-2a4d3f9e1b01';

const scheduled = (id: string, over: Partial<ScheduledMessage> = {}): ScheduledMessage => ({
  id,
  channelId: IDS.api,
  parentId: null,
  content: 'Pool size to 20?',
  attachments: [],
  sendAt: '2026-09-10T09:00:00.000Z',
  state: 'pending',
  sentMessageId: null,
  failureCode: null,
  createdAt: WHEN,
  updatedAt: WHEN,
  ...over,
});

const FIRST = '0199155c-6200-7b7f-8c11-2a4d3f9e1b11';
const SECOND = '0199155c-6200-7b7f-8c11-2a4d3f9e1b12';

const file = (id: string): Attachment => ({
  id,
  fileName: 'plan.txt',
  mimeType: 'text/plain',
  sizeBytes: 4,
  kind: 'file',
  width: null,
  height: null,
});

interface Calls {
  readonly listed: number;
  readonly cancelled: { channelId: string; id: string }[];
  readonly scheduled: { channelId: string; id: string; body: unknown }[];
}

const visit = async (
  rows: ScheduledMessage[] | (() => Promise<ScheduledMessage[]>),
  options: {
    readonly drafts?: Readonly<Record<string, string>>;
    readonly api?: Partial<Api>;
    readonly session?: MeResponse;
    readonly locale?: 'en' | 'tr';
    readonly path?: string;
  } = {},
): Promise<
  Awaited<ReturnType<typeof renderApp>> & {
    storage: ReturnType<typeof memoryStorage>;
    calls: Calls;
  }
> => {
  const storage = memoryStorage(options.drafts ?? {});
  // What the server holds: a cancel takes its message out of it, as the real one does.
  let held: ScheduledMessage[] = typeof rows === 'function' ? [] : [...rows];
  const calls = { listed: 0, cancelled: [], scheduled: [] } as {
    listed: number;
    cancelled: { channelId: string; id: string }[];
    scheduled: { channelId: string; id: string; body: unknown }[];
  };
  const view = await renderApp(
    <ComposerPortsContext.Provider
      value={{ storage, schedule: () => (): void => undefined, touchOnly: () => false }}
    >
      <Outlet />
      <Toaster dismissLabel="Close" />
    </ComposerPortsContext.Provider>,
    {
      path: options.path ?? '/w/acme/drafts',
      ...(options.locale === undefined ? {} : { locale: options.locale }),
      api: aSignedInApi({
        me: () => Promise.resolve(options.session ?? aSession()),
        listScheduledMessages: () => {
          calls.listed += 1;
          return typeof rows === 'function' ? rows() : Promise.resolve(held);
        },
        cancelScheduledMessage: (channelId, id) => {
          calls.cancelled.push({ channelId, id });
          held = held.filter((item) => item.id !== id);
          return Promise.resolve();
        },
        scheduleMessage: (channelId, id, body) => {
          calls.scheduled.push({ channelId, id, body });
          return Promise.resolve(scheduled(id, { channelId }));
        },
        ...options.api,
      }),
    },
  );
  await settle();
  return Object.assign(view, { storage, calls });
};

const openTab = async (view: Awaited<ReturnType<typeof visit>>): Promise<void> => {
  await person().click(
    within(view.getByRole('group', { name: /^(Show|Göster)$/ })).getByRole('button', {
      name: /^(Scheduled|Zamanlananlar)/,
    }),
  );
  await settle();
};

const rowAt = (view: Awaited<ReturnType<typeof visit>>, index: number): HTMLElement => {
  const row = within(view.getByRole('main')).getAllByRole('listitem')[index];
  if (row === undefined) throw new Error(`no row ${String(index)}`);
  return row;
};

describe('the tab', () => {
  test('says how many are waiting, and none when there are none', async () => {
    const some = await visit([scheduled(FIRST), scheduled(SECOND)]);
    expect(await some.findByRole('button', { name: 'Scheduled (2)' })).toBeDefined();
    some.unmount();
    const none = await visit([]);
    expect(none.getByRole('button', { name: 'Scheduled' })).toBeDefined();
  });

  test('is in Turkish', async () => {
    const view = await visit([scheduled(FIRST)], { locale: 'tr' });
    expect(await view.findByRole('button', { name: 'Zamanlananlar (1)' })).toBeDefined();
  });

  test('opens when the address asks for it, as View scheduled does', async () => {
    const view = await visit([scheduled(FIRST)], { path: '/w/acme/drafts?tab=scheduled' });
    expect(view.getByText('Pool size to 20?')).toBeDefined();
  });

  test('is not there, and nothing is asked, where the server holds nothing for later', async () => {
    const session = aSession();
    const view = await visit([], {
      session: {
        ...session,
        modules: [],
        memberships: session.memberships.map((membership) => ({ ...membership, modules: [] })),
      },
      api: {
        listScheduledMessages: () => {
          throw new Error('asked for scheduled messages');
        },
      },
    });
    expect(view.queryByRole('button', { name: /^Scheduled/ })).toBeNull();
  });
});

describe('the list', () => {
  test('shows where, when, the words and the files of each, in the order the server gave', async () => {
    const view = await visit([
      scheduled(FIRST, { sendAt: '2026-09-09T14:30:00.000Z', content: 'Today’s words' }),
      scheduled(SECOND, {
        channelId: IDS.deploys,
        parentId: ROOT,
        sendAt: '2026-09-11T06:00:00.000Z',
        content: 'Yes, after the window.',
        attachments: [
          file('0199155c-6200-7b7f-8c11-2a4d3f9e1b21'),
          file('0199155c-6200-7b7f-8c11-2a4d3f9e1b22'),
        ],
      }),
    ]);
    await openTab(view);
    expect(within(view.getByRole('main')).getAllByRole('listitem')).toHaveLength(2);
    expect(within(rowAt(view, 0)).getByText('api')).toBeDefined();
    expect(within(rowAt(view, 0)).getByText('Today at 14:30')).toBeDefined();
    expect(within(rowAt(view, 0)).getByText('Today’s words')).toBeDefined();
    expect(within(rowAt(view, 1)).getByText('deploys')).toBeDefined();
    expect(within(rowAt(view, 1)).getByText('· in a thread')).toBeDefined();
    expect(within(rowAt(view, 1)).getByText('Fri, Sep 11 at 06:00')).toBeDefined();
    expect(within(rowAt(view, 1)).getByText('2 files')).toBeDefined();
  });

  test('says when in the language of the person, in their zone', async () => {
    const view = await visit([scheduled(FIRST)], { locale: 'tr' });
    await openTab(view);
    expect(view.getByText('Yarın 09:00')).toBeDefined();
  });

  test('a message in a channel the person can no longer see is not listed', async () => {
    const view = await visit([scheduled(FIRST, { channelId: 'gone-channel', content: 'lost' })]);
    await openTab(view);
    expect(view.queryByText('lost')).toBeNull();
    expect(view.getByText('Nothing scheduled')).toBeDefined();
  });

  test('opens the place on a press: the channel, or the thread', async () => {
    const view = await visit([scheduled(FIRST, { channelId: IDS.deploys, parentId: ROOT })]);
    await openTab(view);
    await person().click(view.getByRole('button', { name: /Pool size to 20\?/ }));
    expect(view.world.history.stack.at(-1)).toBe(`/w/acme/c/${IDS.deploys}?thread=${ROOT}`);
  });

  test.each([
    ['CHANNEL_NOT_FOUND', 'the channel is gone or you can no longer see it'],
    ['NOT_A_CHANNEL_MEMBER', 'you are no longer in the channel'],
    ['ONLY_ADMINS_POST', 'only admins can post in this channel now'],
    ['MESSAGE_NOT_FOUND', 'the message you replied to is gone'],
    ['ATTACHMENT_NOT_FOUND', 'a file is no longer available'],
    ['FORBIDDEN', 'you no longer have access'],
    ['SOMETHING_NEW', 'it could not be delivered'],
    [null, 'it could not be delivered'],
  ])('a failed one says why (%s)', async (code, reason) => {
    const view = await visit([scheduled(FIRST, { state: 'failed', failureCode: code })]);
    await openTab(view);
    expect(view.getByText(`Failed: ${reason}`)).toBeDefined();
  });

  test('a failed one says why in Turkish', async () => {
    const view = await visit(
      [scheduled(FIRST, { state: 'failed', failureCode: 'NOT_A_CHANNEL_MEMBER' })],
      { locale: 'tr' },
    );
    await openTab(view);
    expect(view.getByText('Gönderilemedi: artık kanalda değilsin')).toBeDefined();
  });

  test('a pending one says nothing of failure', async () => {
    const view = await visit([scheduled(FIRST)]);
    await openTab(view);
    expect(view.queryByText(/Failed/)).toBeNull();
  });

  test('none says so', async () => {
    const view = await visit([]);
    await openTab(view);
    expect(view.getByText('Nothing scheduled')).toBeDefined();
  });

  test('a failure to load says so, and Retry asks again', async () => {
    let answers = 0;
    const view = await visit(() => {
      answers += 1;
      return answers <= 2
        ? Promise.reject(new Error('offline'))
        : Promise.resolve([scheduled(FIRST)]);
    });
    await openTab(view);
    expect(view.getByText('Couldn’t load your scheduled messages')).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(view.getByText('Pool size to 20?')).toBeDefined();
  });
});

describe('reading it again', () => {
  test('opening the tab asks, and so does the window coming back into focus', async () => {
    const view = await visit([scheduled(FIRST)]);
    const atStart = view.calls.listed;
    await openTab(view);
    expect(view.calls.listed).toBe(atStart + 1);
    await act(async () => {
      window.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    await settle();
    expect(view.calls.listed).toBeGreaterThan(atStart + 1);
  });
});

describe('cancelling', () => {
  test('asks the server, takes the row away and says so, with Undo', async () => {
    const view = await visit([scheduled(FIRST), scheduled(SECOND, { content: 'Another one' })]);
    await openTab(view);
    const row = rowAt(view, 0);
    await person().click(within(row).getByRole('button', { name: 'Cancel scheduled message' }));
    await settle();
    expect(view.calls.cancelled).toEqual([{ channelId: IDS.api, id: FIRST }]);
    expect(view.queryByText('Pool size to 20?')).toBeNull();
    expect(view.getByText('Another one')).toBeDefined();
    expect(view.getByText('Scheduled message cancelled')).toBeDefined();
  });

  test('Undo asks for the same message again, under the same id', async () => {
    const view = await visit([
      scheduled(FIRST, {
        parentId: ROOT,
        attachments: [file('0199155c-6200-7b7f-8c11-2a4d3f9e1b21')],
      }),
    ]);
    await openTab(view);
    await person().click(view.getByRole('button', { name: 'Cancel scheduled message' }));
    await settle();
    await person().click(view.getByRole('button', { name: 'Undo' }));
    await settle();
    expect(view.calls.scheduled).toEqual([
      {
        channelId: IDS.api,
        id: FIRST,
        body: {
          content: 'Pool size to 20?',
          parentId: ROOT,
          attachmentIds: ['0199155c-6200-7b7f-8c11-2a4d3f9e1b21'],
          sendAt: '2026-09-10T09:00:00.000Z',
        },
      },
    ]);
  });

  test('Undo that can no longer be done says so, and the message stays cancelled', async () => {
    const view = await visit([scheduled(FIRST)], {
      api: {
        scheduleMessage: () => Promise.reject(new ApiError(400, 'VALIDATION_FAILED', 'late')),
      },
    });
    await openTab(view);
    await person().click(view.getByRole('button', { name: 'Cancel scheduled message' }));
    await settle();
    await person().click(view.getByRole('button', { name: 'Undo' }));
    await settle();
    expect(
      view.getByText('It couldn’t be restored. Schedule it again from the message box.'),
    ).toBeDefined();
  });

  test('one that was already sent says so, and the list is read again', async () => {
    let answers = 0;
    const view = await visit(
      () => {
        answers += 1;
        return Promise.resolve(answers <= 2 ? [scheduled(FIRST)] : []);
      },
      {
        api: {
          cancelScheduledMessage: () =>
            Promise.reject(new ApiError(409, 'SCHEDULED_MESSAGE_SENT', 'sent')),
        },
      },
    );
    await openTab(view);
    await person().click(view.getByRole('button', { name: 'Cancel scheduled message' }));
    await settle();
    expect(view.getByText('It was already sent.')).toBeDefined();
    expect(view.queryByText('Pool size to 20?')).toBeNull();
  });

  test('one that is gone already, cancelled elsewhere, is as good as cancelled', async () => {
    let gone = false;
    const view = await visit(() => Promise.resolve(gone ? [] : [scheduled(FIRST)]), {
      api: {
        cancelScheduledMessage: () => {
          gone = true;
          return Promise.reject(new ApiError(404, 'SCHEDULED_MESSAGE_NOT_FOUND', 'gone'));
        },
      },
    });
    await openTab(view);
    await person().click(view.getByRole('button', { name: 'Cancel scheduled message' }));
    await settle();
    expect(view.queryByText('Pool size to 20?')).toBeNull();
  });

  test('no connection is said, and the message stays in the list', async () => {
    const view = await visit([scheduled(FIRST)], {
      api: { cancelScheduledMessage: () => Promise.reject(new ApiError(0, 'NETWORK', 'down')) },
    });
    await openTab(view);
    await person().click(view.getByRole('button', { name: 'Cancel scheduled message' }));
    await settle();
    expect(view.getByText('Check your connection and try again.')).toBeDefined();
    expect(view.getByText('Pool size to 20?')).toBeDefined();
  });

  test('a double press is one request', async () => {
    let release: () => void = () => undefined;
    let gone = false;
    const asked: string[] = [];
    const view = await visit(() => Promise.resolve(gone ? [] : [scheduled(FIRST)]), {
      api: {
        cancelScheduledMessage: (_channelId, id) => {
          asked.push(id);
          return new Promise<void>((resolve) => {
            release = (): void => {
              gone = true;
              resolve();
            };
          });
        },
      },
    });
    await openTab(view);
    const button = view.getByRole('button', { name: 'Cancel scheduled message' });
    await person().click(button);
    await person().click(button);
    await act(async () => {
      release();
      await Promise.resolve();
    });
    await settle();
    expect(asked).toEqual([FIRST]);
    expect(view.queryByText('Pool size to 20?')).toBeNull();
  });
});

describe('editing', () => {
  test('moves the words into the place’s draft, cancels the schedule, says so and opens the box', async () => {
    const view = await visit([scheduled(FIRST, { content: 'Reword me' })]);
    await openTab(view);
    await person().click(view.getByRole('button', { name: 'Edit scheduled message' }));
    await settle();
    expect(view.storage.getItem(draftKey(ME, IDS.api, undefined))).toBe('Reword me');
    expect(view.calls.cancelled).toEqual([{ channelId: IDS.api, id: FIRST }]);
    expect(view.getByText('Back in your draft in api, and no longer scheduled.')).toBeDefined();
    expect(view.world.history.stack.at(-1)).toBe(`/w/acme/c/${IDS.api}`);
  });

  test('a reply goes back to its thread’s draft, and words already there are kept above', async () => {
    const key = draftKey(ME, IDS.deploys, ROOT);
    const view = await visit(
      [scheduled(FIRST, { channelId: IDS.deploys, parentId: ROOT, content: 'Scheduled words' })],
      { drafts: { [key]: 'Already typing  ' } },
    );
    await openTab(view);
    await person().click(view.getByRole('button', { name: 'Edit scheduled message' }));
    await settle();
    expect(view.storage.getItem(key)).toBe('Already typing\n\nScheduled words');
    expect(view.world.history.stack.at(-1)).toBe(`/w/acme/c/${IDS.deploys}?thread=${ROOT}`);
  });

  test('says that its files were not kept', async () => {
    const view = await visit([
      scheduled(FIRST, { attachments: [file('0199155c-6200-7b7f-8c11-2a4d3f9e1b21')] }),
    ]);
    await openTab(view);
    await person().click(view.getByRole('button', { name: 'Edit scheduled message' }));
    await settle();
    expect(
      view.getByText(
        'Back in your draft in api, and no longer scheduled. Its 1 file was not kept; attach it again.',
      ),
    ).toBeDefined();
  });

  test('says it in Turkish', async () => {
    const view = await visit([scheduled(FIRST)], { locale: 'tr' });
    await openTab(view);
    await person().click(view.getByRole('button', { name: 'Zamanlanmış mesajı düzenle' }));
    await settle();
    expect(
      view.getByText('api içindeki taslağına geri taşındı, artık zamanlanmış değil.'),
    ).toBeDefined();
  });

  test('when the cancel is refused the draft is put back as it was and the message stays', async () => {
    const key = draftKey(ME, IDS.api, undefined);
    const view = await visit([scheduled(FIRST)], {
      drafts: { [key]: 'Mine' },
      api: {
        cancelScheduledMessage: () =>
          Promise.reject(new ApiError(409, 'SCHEDULED_MESSAGE_SENT', 'sent')),
      },
    });
    await openTab(view);
    await person().click(view.getByRole('button', { name: 'Edit scheduled message' }));
    await settle();
    expect(view.storage.getItem(key)).toBe('Mine');
    expect(view.getByText('It was already sent.')).toBeDefined();
    expect(view.world.history.stack.at(-1)).toBe('/w/acme/drafts');
  });

  test('when this device cannot keep the draft, nothing is cancelled', async () => {
    const view = await visit([scheduled(FIRST)]);
    Reflect.set(view.storage, 'setItem', (): void => {
      throw new Error('full');
    });
    await openTab(view);
    await person().click(view.getByRole('button', { name: 'Edit scheduled message' }));
    await settle();
    expect(view.calls.cancelled).toEqual([]);
    expect(
      view.getByText('This device couldn’t save the draft, so the message stays scheduled.'),
    ).toBeDefined();
  });
});
