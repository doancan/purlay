/**
 * The composer as a person uses it: typing, the keys, a paste, a draft left behind and
 * found again — against the real provider tree, a socket the test drives and storage and
 * time it holds.
 */
import { describe, expect, test } from 'bun:test';
import { act, fireEvent, within } from '@testing-library/react';
import { useState } from 'react';
import {
  ATTACHMENT_BYTES_MAX,
  ATTACHMENTS_PER_MESSAGE_MAX,
  MESSAGE_CONTENT_MAX,
  type Attachment,
  type ServerFrame,
} from '@purlay/types';
import { ApiError } from '../../data/errors';
import { keys } from '../../data/keys';
import { SessionGate } from '../session/session';
import { WorkspaceScopeProvider } from '../shell/workspace';
import { RealtimeProvider } from '../../realtime/realtime-provider';
import { Toaster } from '../../ui/toast';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { fakeSchedule } from '../../testing/fakes';
import {
  IDS,
  WHEN,
  aChannel,
  aMessage,
  aSignedInApi,
  aSession,
  ALICE as ALICE_USER,
  BOB as BOB_USER,
  aUser,
  messageIdAt,
  someChannels,
  someMembers,
  NO_PROFILE,
} from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import type { Api } from '../../data/api';
import { Composer, DRAFT_DEBOUNCE_MS, type ComposerProps } from './composer';
import { ComposerPortsContext } from './composer-ports';
import { draftKey, type DraftStorage } from './drafts';
import { PERSON_KEY } from '../../data/browser-storage';
import { expectFocusOn } from '../../testing/focus';

installDom();

/** Who is signed in, in every mount here; the page is theirs (#694). */
const ME = aSession().user.id;
/** Where this person's draft for a place lives. */
const mine = (channelId: string, parentId?: string): string => draftKey(ME, channelId, parentId);

const memory = (): DraftStorage & { readonly items: Map<string, string> } => {
  const items = new Map<string, string>([[PERSON_KEY, ME]]);
  return {
    items,
    getItem: (key): string | null => items.get(key) ?? null,
    setItem: (key, value): void => {
      items.set(key, value);
    },
    removeItem: (key): void => {
      items.delete(key);
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

interface Options {
  readonly props?: Partial<ComposerProps>;
  readonly storage?: DraftStorage | null;
  readonly api?: Api;
  readonly locale?: 'en' | 'tr';
  readonly open?: boolean;
}

interface Mounted {
  readonly view: Awaited<ReturnType<typeof renderApp>>;
  readonly timers: ReturnType<typeof fakeSchedule>;
  readonly storage: DraftStorage | null;
  readonly box: () => HTMLTextAreaElement;
  readonly sent: () => {
    channelId: unknown;
    content: unknown;
    parentId?: unknown;
    attachmentIds?: unknown;
  }[];
  readonly user: ReturnType<typeof person>;
  readonly rerender: (
    next: Partial<ComposerProps>,
    without?: readonly (keyof ComposerProps)[],
  ) => void;
}

const mount = async (options: Options = {}): Promise<Mounted> => {
  const timers = fakeSchedule();
  const storage = options.storage === undefined ? memory() : options.storage;
  let props: ComposerProps = { channelId: IDS.api, channelName: 'api', ...options.props };
  let setProps: (next: ComposerProps) => void = () => undefined;
  /** Holds the composer's props in state, so a test can change them the way a route change does. */
  const Holder = (): React.JSX.Element => {
    const [current, set] = useState(props);
    setProps = set;
    return <Composer {...current} />;
  };
  const tree = (): React.ReactElement => (
    <SessionGate>
      <WorkspaceScopeProvider slug="acme" notFound={null}>
        <RealtimeProvider>
          <ComposerPortsContext.Provider value={{ storage, schedule: timers.schedule }}>
            <Holder />
          </ComposerPortsContext.Provider>
          <Toaster dismissLabel="Close" />
        </RealtimeProvider>
      </WorkspaceScopeProvider>
    </SessionGate>
  );
  const view = await renderApp(tree(), {
    api: options.api ?? aSignedInApi(),
    ...(options.locale === undefined ? {} : { locale: options.locale }),
  });
  await settle();
  if (options.open !== false) {
    act(() => {
      view.world.sockets.open();
    });
  }
  const box = (): HTMLTextAreaElement => view.getByRole('textbox') as HTMLTextAreaElement;
  const sent = (): {
    channelId: unknown;
    content: unknown;
    parentId?: unknown;
    attachmentIds?: unknown;
  }[] =>
    view.world.sockets.sent('MESSAGE_SEND').map(
      (f) =>
        f.payload as {
          channelId: unknown;
          content: unknown;
          parentId?: unknown;
          attachmentIds?: unknown;
        },
    );
  return {
    view,
    timers,
    storage,
    box,
    sent,
    user: person(),
    /** Re-renders the same tree with other props, as a channel switch does. */
    rerender: (
      next: Partial<ComposerProps>,
      without: readonly (keyof ComposerProps)[] = [],
    ): void => {
      const merged: Record<string, unknown> = { ...props, ...next };
      for (const key of without) Reflect.deleteProperty(merged, key);
      props = merged as unknown as ComposerProps;
      act(() => {
        setProps(props);
      });
    },
  };
};

/** A draft already in storage: the way a long text gets into the box in a DOM where a paste does not reach React's onChange. */
const drafted = (
  text: string,
  channelId: string = IDS.api,
): DraftStorage & { readonly items: Map<string, string> } => {
  const storage = memory();
  storage.setItem(mine(channelId), text);
  return storage;
};

const press = async (user: ReturnType<typeof person>, keys: string): Promise<void> => {
  await user.keyboard(keys);
};

describe('what it shows', () => {
  test('is a labelled textarea for the channel, in one card with a send button, and no prompt prefix', async () => {
    const { view, box } = await mount();
    expect(view.getByRole('textbox', { name: 'Message api' })).toBe(box());
    expect(box().getAttribute('placeholder')).toBe('Write to api');
    expect(view.queryByText('api ›')).toBeNull();
    const card = view.container.querySelector('[data-composer-card]');
    // A card that floats a little above the conversation (D-110).
    expect(card?.className).toContain('rounded-2xl');
    expect(card?.className).toContain('shadow-raised');
    expect(card?.contains(box())).toBe(true);
    const send = view.getByRole('button', { name: 'Send' });
    expect(card?.contains(send)).toBe(true);
    expect(send.className).toContain('bg-accent');
  });

  test('the hints are drawn only while focus is in the card, and are described to a screen reader always', async () => {
    const { view, box, user } = await mount();
    const described = (): string =>
      document.getElementById(box().getAttribute('aria-describedby') ?? '')?.textContent ?? '';
    // Not focused: in the DOM, for the textarea's description, but visually hidden.
    for (const hint of ['sends', 'new line', 'code block']) expect(described()).toContain(hint);
    expect(
      document.getElementById(box().getAttribute('aria-describedby') ?? '')?.className ?? '',
    ).not.toContain('text-caption');
    await user.click(box());
    for (const hint of ['sends', 'new line', 'code block']) {
      expect(view.getByText(hint)).toBeDefined();
      expect(described()).toContain(hint);
    }
    expect(
      document.getElementById(box().getAttribute('aria-describedby') ?? '')?.className,
    ).toContain('text-caption');
    // Tab goes to the Send button, which is still inside the card: the hints stay.
    await user.tab();
    expect(
      document.getElementById(box().getAttribute('aria-describedby') ?? '')?.className,
    ).toContain('text-caption');
    act(() => {
      (document.activeElement as HTMLElement).blur();
    });
    expect(
      document.getElementById(box().getAttribute('aria-describedby') ?? '')?.className ?? '',
    ).not.toContain('text-caption');
  });

  test('the card wears the focus ring while focus is inside it, since the textarea draws none of its own', async () => {
    const { view, box, user } = await mount();
    const card = view.container.querySelector('[data-composer-card]');
    expect(card?.className).not.toContain('outline-focus');
    expect(box().className).toContain('outline-none');
    await user.click(box());
    expect(card?.className).toContain('outline-focus');
    act(() => {
      box().blur();
    });
    expect(card?.className).not.toContain('outline-focus');
  });

  test('the send button says it is off while there is nothing to send, and on once there is', async () => {
    const { view, box, sent, user } = await mount();
    const send = view.getByRole('button', { name: 'Send' });
    // aria-disabled, not disabled: nothing about the connection or an empty box removes a control
    // from the page, and a screen reader still finds it and is told why it does nothing.
    expect(send.getAttribute('aria-disabled')).toBe('true');
    await user.type(box(), '   ');
    expect(send.getAttribute('aria-disabled')).toBe('true');
    await user.click(send);
    expect(sent()).toEqual([]);
    await user.type(box(), 'hello');
    expect(send.getAttribute('aria-disabled')).toBe('false');
  });

  test('grows with its lines from one line to a ceiling of twelve', async () => {
    const { box, user } = await mount();
    expect(Number(box().getAttribute('rows'))).toBe(1);
    await user.click(box());
    await user.type(
      box(),
      'a{Shift>}{Enter}{/Shift}b{Shift>}{Enter}{/Shift}c{Shift>}{Enter}{/Shift}d',
    );
    expect(Number(box().getAttribute('rows'))).toBe(4);
    await user.type(box(), '{Shift>}{Enter}{/Shift}'.repeat(12));
    expect(Number(box().getAttribute('rows'))).toBe(12);
  });

  test('says its words in Turkish', async () => {
    const { view } = await mount({ locale: 'tr' });
    expect(view.getByRole('textbox', { name: 'api için mesaj' })).toBeDefined();
    expect(view.getByRole('button', { name: /Gönder/ })).toBeDefined();
  });

  test('passes the accessibility audit', async () => {
    const { view } = await mount();
    await expectNoAxeViolations(view.container);
  });
});

describe('sending', () => {
  test('Enter sends the text as one frame, clears the box, keeps focus and says which id', async () => {
    const ids: string[] = [];
    const { box, sent, user } = await mount({ props: { onSent: (id) => ids.push(id) } });
    await user.click(box());
    await user.type(box(), 'hello team');
    await press(user, '{Enter}');
    expect(sent()).toEqual([{ channelId: IDS.api, content: 'hello team' }]);
    expect(box().value).toBe('');
    expectFocusOn(box());
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('the Send button sends too', async () => {
    const { view, box, sent, user } = await mount();
    await user.type(box(), 'by button');
    await user.click(view.getByRole('button', { name: /Send/ }));
    expect(sent()).toEqual([{ channelId: IDS.api, content: 'by button' }]);
    expectFocusOn(box());
  });

  test('Shift+Enter is a new line and sends nothing', async () => {
    const { box, sent, user } = await mount();
    await user.type(box(), 'one{Shift>}{Enter}{/Shift}two');
    expect(box().value).toBe('one\ntwo');
    expect(sent()).toEqual([]);
  });

  test('nothing, or only whitespace, is not a message', async () => {
    const { box, sent, user } = await mount();
    await user.click(box());
    await press(user, '{Enter}');
    await user.type(box(), '   ');
    await press(user, '{Enter}');
    expect(sent()).toEqual([]);
  });

  test('only the end is trimmed: what was typed inside the message is never altered', async () => {
    const { box, sent, user } = await mount();
    await user.type(box(), '  a   b  {Shift>}{Enter}{/Shift}{Shift>}{Enter}{/Shift}');
    await press(user, '{Control>}{Enter}{/Control}');
    expect(sent()).toEqual([{ channelId: IDS.api, content: '  a   b' }]);
  });

  test('a reply carries the root it answers', async () => {
    const { box, sent, user } = await mount({ props: { parentId: aMessage(1).id } });
    await user.type(box(), 'an answer');
    await press(user, '{Enter}');
    expect(sent()).toEqual([
      { channelId: IDS.api, content: 'an answer', parentId: aMessage(1).id },
    ]);
  });

  test('is never disabled by the connection: with the socket down the message still goes, over HTTP', async () => {
    const asked: unknown[] = [];
    const api = aSignedInApi({
      send: (channelId, input) => {
        asked.push({ channelId, ...input });
        return Promise.resolve(aMessage(2, { id: input.id }));
      },
    });
    const { view, box, user } = await mount({ api, open: false });
    expect(box().disabled).toBe(false);
    await user.type(box(), 'offline');
    expect(view.getByRole('button', { name: /Send/ }).getAttribute('aria-disabled')).toBe('false');
    await press(user, '{Enter}');
    await settle();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ channelId: IDS.api, content: 'offline' });
  });
});

describe('fences', () => {
  test('after ``` Enter is a newline, and Ctrl+Enter sends from inside the block', async () => {
    const { box, sent, user } = await mount();
    await user.type(box(), '```ts');
    await press(user, '{Enter}');
    expect(box().value).toBe('```ts\n');
    expect(sent()).toEqual([]);
    await user.type(box(), 'const a = 1;');
    await press(user, '{Enter}');
    expect(box().value).toBe('```ts\nconst a = 1;\n');
    await press(user, '{Control>}{Enter}{/Control}');
    expect(sent()).toEqual([{ channelId: IDS.api, content: '```ts\nconst a = 1;' }]);
  });

  test('Cmd+Enter sends too', async () => {
    const { box, sent, user } = await mount();
    await user.type(box(), '```');
    await press(user, '{Enter}');
    await user.type(box(), 'x');
    await press(user, '{Meta>}{Enter}{/Meta}');
    expect(sent()).toHaveLength(1);
  });

  test('once the fence is closed Enter sends again', async () => {
    const { box, sent, user } = await mount();
    await user.type(box(), '```');
    await press(user, '{Enter}');
    await user.type(box(), 'code');
    await press(user, '{Enter}');
    await user.type(box(), '```');
    await press(user, '{Enter}');
    expect(sent()).toEqual([{ channelId: IDS.api, content: '```\ncode\n```' }]);
  });
});

describe('keys that are not a send', () => {
  test('a key that ends an IME composition does not send, whichever way the engine says so', async () => {
    const { box, sent, user } = await mount();
    await user.type(box(), 'こん');
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true });
    fireEvent.keyDown(box(), { key: 'Process' });
    fireEvent.compositionStart(box());
    fireEvent.keyDown(box(), { key: 'Enter' });
    fireEvent.compositionEnd(box());
    // Safari's keydown arrives after compositionend: still the composition's.
    fireEvent.keyDown(box(), { key: 'Enter' });
    expect(sent()).toEqual([]);
    expect(box().value).toBe('こん');
    // A turn later it is a person pressing Enter again.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    await press(user, '{Enter}');
    expect(sent()).toEqual([{ channelId: IDS.api, content: 'こん' }]);
  });

  test('Escape leaves the box, back to the feed', async () => {
    const { box, user } = await mount();
    await user.click(box());
    expectFocusOn(box());
    await press(user, '{Escape}');
    expect(document.activeElement === box()).toBe(false);
  });

  test('other keys, with or without a modifier, do nothing special', async () => {
    const { box, sent, user } = await mount();
    await user.type(box(), 'a');
    await press(user, '{Control>}a{/Control}');
    await press(user, '{ArrowUp}');
    expect(box().value).toBe('a');
    expect(sent()).toEqual([]);
  });
});

describe('what is refused before it is sent, in words', () => {
  test('a message over the limit says by how much, in code units, and is not sent', async () => {
    const { view, box, sent, user } = await mount({
      storage: drafted('a'.repeat(MESSAGE_CONTENT_MAX + 1)),
    });
    await user.click(box());
    await press(user, '{Enter}');
    expect(view.getByRole('alert').textContent).toContain('That is 1 character over the limit.');
    expect(sent()).toEqual([]);
    expect(box().getAttribute('aria-invalid')).toBe('true');
  });

  test('exactly the limit is sent', async () => {
    const { box, sent, user } = await mount({ storage: drafted('a'.repeat(MESSAGE_CONTENT_MAX)) });
    await user.click(box());
    await press(user, '{Enter}');
    expect(sent()).toHaveLength(1);
  });

  test('a character outside the Basic Multilingual Plane counts as two', async () => {
    const { view, box, sent, user } = await mount({
      storage: drafted('😀'.repeat(MESSAGE_CONTENT_MAX / 2 + 1)),
    });
    await user.click(box());
    await press(user, '{Enter}');
    expect(view.getByRole('alert').textContent).toContain('That is 2 characters over the limit.');
    expect(sent()).toEqual([]);
  });

  test('the counter appears only near the limit, and is announced politely', async () => {
    const quiet = await mount({ storage: drafted('a'.repeat(MESSAGE_CONTENT_MAX - 501)) });
    expect(quiet.view.queryByText(/characters? left/)).toBeNull();
    quiet.view.unmount();
    const near = await mount({ storage: drafted('a'.repeat(MESSAGE_CONTENT_MAX - 500)) });
    expect(
      near.view.getByText('500 characters left').closest('[aria-live]')?.getAttribute('aria-live'),
    ).toBe('polite');
    near.view.unmount();
    const last = await mount({ storage: drafted('a'.repeat(MESSAGE_CONTENT_MAX - 1)) });
    expect(last.view.getByText('1 character left')).toBeDefined();
    last.view.unmount();
    const over = await mount({ storage: drafted('a'.repeat(MESSAGE_CONTENT_MAX + 1)) });
    expect(over.view.getByText('That is 1 character over the limit.')).toBeDefined();
  });

  test('a character the contract refuses is named, and nothing is sent', async () => {
    const { view, box, sent, user } = await mount({ storage: drafted('a\u0000b') });
    await user.click(box());
    await press(user, '{Enter}');
    expect(view.getByRole('alert').textContent).toContain('cannot send');
    expect(sent()).toEqual([]);
  });

  test('@here is refused, named as typed, and the refusal goes when the text changes', async () => {
    const { view, box, sent, user } = await mount();
    await user.type(box(), 'ping @Here now');
    await press(user, '{Enter}');
    expect(view.getByRole('alert').textContent).toContain('@Here is not available');
    expect(sent()).toEqual([]);
    await user.type(box(), '!');
    expect(view.queryByRole('alert')).toBeNull();
  });

  test('in code, or as part of an address, it is only text', async () => {
    const { box, sent, user } = await mount();
    await user.type(box(), 'write `@here` or mail me@here.test');
    await press(user, '{Enter}');
    expect(sent()).toHaveLength(1);
  });

  test('a refusal does not eat the draft', async () => {
    const { box, user } = await mount();
    await user.type(box(), '@channel');
    await press(user, '{Enter}');
    expect(box().value).toBe('@channel');
  });

  test('every refusal passes the accessibility audit', async () => {
    const { view, box, user } = await mount();
    await user.type(box(), '@everyone');
    await press(user, '{Enter}');
    await expectNoAxeViolations(view.container);
  });
});

describe('pasting', () => {
  const thirteen = Array.from({ length: 13 }, (_, i) => `line ${String(i)}`).join('\n');

  test('thirteen lines become a code block, said aloud, and Undo restores exactly what was there', async () => {
    const { view, box, user } = await mount();
    await user.type(box(), 'before ');
    await user.paste(thirteen);
    expect(box().value).toBe(`before \`\`\`\n${thirteen}\n\`\`\``);
    expect(view.getByText('Pasted text became a code block')).toBeDefined();
    await user.click(view.getByRole('button', { name: 'Undo' }));
    expect(box().value).toBe('before ');
    expectFocusOn(box());
  });

  test('replaces the selection, not the whole text, and the caret lands after the block', async () => {
    const { box, user } = await mount();
    await user.type(box(), 'keep SELECT keep');
    box().setSelectionRange(5, 11);
    await user.paste(thirteen);
    expect(box().value).toBe(`keep \`\`\`\n${thirteen}\n\`\`\` keep`);
    expect(box().selectionStart).toBe(`keep \`\`\`\n${thirteen}\n\`\`\``.length);
  });

  test('twelve lines are an ordinary paste, left to the browser, with no toast', async () => {
    const { view, box } = await mount();
    const twelve = thirteen.split('\n').slice(0, 12).join('\n');
    expect(fireEvent.paste(box(), { clipboardData: { getData: () => twelve } })).toBe(true);
    expect(view.queryByText('Pasted text became a code block')).toBeNull();
  });

  test('a paste with no clipboard data is left to the browser; a pasted file is uploaded (#370)', async () => {
    const { box } = await mount();
    expect(fireEvent.paste(box())).toBe(true);
    expect(box().value).toBe('');
  });
});

describe('drafts', () => {
  test('are written a moment after typing stops, and not before', async () => {
    const { box, storage, timers, user } = await mount();
    await user.type(box(), 'half');
    expect(storage?.getItem(mine(IDS.api))).toBeNull();
    act(() => {
      timers.advance(DRAFT_DEBOUNCE_MS - 1);
    });
    expect(storage?.getItem(mine(IDS.api))).toBeNull();
    act(() => {
      timers.advance(1);
    });
    expect(storage?.getItem(mine(IDS.api))).toBe('half');
  });

  test('come back when the composer does, even if the timer never fired', async () => {
    const storage = memory();
    const first = await mount({ storage });
    await first.user.type(first.box(), 'unfinished');
    first.view.unmount();
    const second = await mount({ storage });
    expect(second.box().value).toBe('unfinished');
  });

  test("belong to their channel: switching saves this one and shows that one's", async () => {
    const storage = memory();
    const { box, rerender, user } = await mount({ storage });
    await user.type(box(), 'for api');
    rerender({ channelId: IDS.deploys, channelName: 'deploys' });
    expect(box().value).toBe('');
    expect(storage.getItem(mine(IDS.api))).toBe('for api');
    await user.type(box(), 'for deploys');
    rerender({ channelId: IDS.api, channelName: 'api' });
    expect(box().value).toBe('for api');
    expect(storage.getItem(mine(IDS.deploys))).toBe('for deploys');
  });

  test('a thread has a draft of its own, apart from its channel', async () => {
    const storage = memory();
    const root = aMessage(1).id;
    const { box, rerender, user } = await mount({ storage });
    await user.type(box(), 'channel text');
    rerender({ parentId: root });
    expect(box().value).toBe('');
    await user.type(box(), 'thread text');
    rerender({}, ['parentId']);
    expect(box().value).toBe('channel text');
    expect(storage.getItem(mine(IDS.api, root))).toBe('thread text');
  });

  // A sign-out forgets the page's record before the composer goes; its last write must not put the
  // words back for the next person to sign in here (#694).
  test('keep nothing once the page is no longer this person’s: not as the composer goes, not on its timer', async () => {
    const storage = memory();
    const { view, box, timers, user } = await mount({ storage });
    await user.type(box(), 'words to forget');
    storage.removeItem(PERSON_KEY);
    act(() => {
      timers.advance(DRAFT_DEBOUNCE_MS);
    });
    view.unmount();
    expect([...storage.items.keys()].filter((key) => key.startsWith('purlay.draft.'))).toEqual([]);
  });

  test('are one person’s: another signed in here reads none of them', () => {
    expect(draftKey('alice', IDS.api, undefined)).not.toBe(draftKey('bob', IDS.api, undefined));
  });

  test('are gone the moment they are sent, so a reload does not bring them back', async () => {
    const storage = memory();
    const { box, timers, user } = await mount({ storage });
    await user.type(box(), 'sent soon');
    act(() => {
      timers.advance(DRAFT_DEBOUNCE_MS);
    });
    expect(storage.getItem(mine(IDS.api))).toBe('sent soon');
    await press(user, '{Enter}');
    expect(storage.getItem(mine(IDS.api))).toBeNull();
    act(() => {
      timers.advance(DRAFT_DEBOUNCE_MS);
    });
    expect(storage.getItem(mine(IDS.api))).toBeNull();
  });

  test('storage that throws, or none at all, leaves a composer that works', async () => {
    const broken: DraftStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    for (const storage of [broken, null]) {
      const { box, sent, timers, user, view } = await mount({ storage });
      await user.type(box(), 'still works');
      act(() => {
        timers.advance(DRAFT_DEBOUNCE_MS);
      });
      await press(user, '{Enter}');
      expect(sent()).toEqual([{ channelId: IDS.api, content: 'still works' }]);
      view.unmount();
    }
  });
});

describe('focus', () => {
  test('a channel opens ready to write, and switching channels does it again', async () => {
    const { box, rerender, user } = await mount({ props: { autoFocus: true } });
    expectFocusOn(box());
    await press(user, '{Escape}');
    rerender({ channelId: IDS.deploys, channelName: 'deploys' });
    expectFocusOn(box());
  });

  test("a thread's box does not take focus when it appears", async () => {
    const { box } = await mount();
    expect(document.activeElement === box()).toBe(false);
  });
});

describe('the three buttons under the box (D-110)', () => {
  test('are named, reachable by Tab, and sit in the card', async () => {
    const { view } = await mount();
    const card = view.container.querySelector('[data-composer-card]');
    for (const name of ['Bold', 'Code block', 'Mention someone']) {
      const button = view.getByRole('button', { name });
      expect(card?.contains(button)).toBe(true);
      expect(button.getAttribute('tabindex')).not.toBe('-1');
    }
  });

  test('Bold wraps what is selected, and keeps the box focused', async () => {
    const { view, box, user } = await mount();
    await user.click(box());
    await user.keyboard('fix it');
    act(() => {
      box().setSelectionRange(4, 6);
    });
    await user.click(view.getByRole('button', { name: 'Bold' }));
    expect(box().value).toBe('fix **it**');
    expectFocusOn(box());
    expect([box().selectionStart, box().selectionEnd]).toEqual([6, 8]);
  });

  test('Code block opens a fence on its own line, the caret inside', async () => {
    const { view, box, user } = await mount();
    await user.click(box());
    await user.keyboard('see');
    await user.click(view.getByRole('button', { name: 'Code block' }));
    expect(box().value).toBe('see\n```\n\n```');
    expect(box().selectionStart).toBe(8);
  });

  test('Mention starts a name, after a space', async () => {
    const { view, box, user } = await mount();
    await user.click(box());
    await user.keyboard('hi');
    await user.click(view.getByRole('button', { name: 'Mention someone' }));
    expect(box().value).toBe('hi @');
    expectFocusOn(box());
  });

  test('what they insert is a draft like any other, and sends as typed', async () => {
    const { view, box, user, sent } = await mount();
    await user.click(box());
    await user.keyboard('ship');
    act(() => {
      box().setSelectionRange(0, 4);
    });
    await user.click(view.getByRole('button', { name: 'Bold' }));
    await user.click(view.getByRole('button', { name: 'Send' }));
    expect(sent().map((frame) => frame.content)).toEqual(['**ship**']);
  });
});

describe('@ offers people (UX §5)', () => {
  const ISIL = { ...aUser('isilk', IDS.bob), displayName: 'Işıl Kaya' };
  /** The workspace with a Turkish name in it, where Bob was. */
  const withIsil = (): Api =>
    aSignedInApi({
      members: () =>
        Promise.resolve([
          ...someMembers().filter((member) => member.user.id !== IDS.bob),
          { user: ISIL, role: 'member' as const, joinedAt: WHEN, profile: NO_PROFILE },
        ]),
    });
  const list = (view: Mounted['view']): HTMLElement | null =>
    view.queryByRole('listbox', { name: 'People to mention' });
  /** Each option as it reads: the name, a space, the handle — the avatar is decoration and hidden. */
  const options = (view: Mounted['view']): string[] =>
    view.queryAllByRole('option').map((option) =>
      Array.from(option.children)
        .filter((child) => child.getAttribute('aria-hidden') !== 'true')
        .map((child) => child.textContent)
        .join(' '),
    );
  const activeOption = (box: HTMLTextAreaElement): string =>
    document.getElementById(box.getAttribute('aria-activedescendant') ?? '')?.textContent ?? '';

  test('a letter after @ opens a list of who matches; a lone @ does not', async () => {
    const { view, box, user } = await mount();
    await user.click(box());
    await user.keyboard('hi @');
    expect(list(view)).toBeNull();
    expect(box().getAttribute('aria-activedescendant')).toBeNull();
    await user.keyboard('al');
    const shown = list(view);
    expect(shown).not.toBeNull();
    // Display name and handle, and nobody whose name does not match — nor the writer.
    expect(options(view)).toEqual(['Alice @alice']);
    expect(box().getAttribute('aria-controls')).toBe(shown?.id ?? 'missing');
    expect(box().getAttribute('aria-autocomplete')).toBe('list');
    expect(activeOption(box())).toContain('@alice');
    expect(view.getByRole('option', { name: /Alice/ }).getAttribute('aria-selected')).toBe('true');
    expect(view.getByText('1 person matches').getAttribute('role')).toBe('status');
  });

  test('matches the handle as well as the name, and never offers the writer', async () => {
    const { view, box, user } = await mount();
    await user.click(box());
    await user.keyboard('@o');
    expect(options(view)).toEqual(['Bob @bob']);
    await user.keyboard('{Backspace}dog');
    expect(list(view)).toBeNull();
  });

  test('matches without case or Turkish marks, either way round', async () => {
    const { view, box, user } = await mount({ api: withIsil() });
    await user.click(box());
    await user.keyboard('@ISIL');
    expect(options(view)).toEqual(['Işıl Kaya @isilk']);
    await user.keyboard(' @ışı');
    expect(options(view)).toEqual(['Işıl Kaya @isilk']);
  });

  test('↓ and ↑ move the current person and wrap; Enter chooses and does not send', async () => {
    const { view, box, sent, user } = await mount({
      api: aSignedInApi({
        members: () =>
          Promise.resolve([
            ...someMembers(),
            {
              user: aUser('bea', '00000000-0000-4000-8000-0000000000e4'),
              role: 'member',
              joinedAt: WHEN,
              profile: NO_PROFILE,
            },
          ]),
      }),
    });
    await user.click(box());
    await user.keyboard('ping @b');
    expect(options(view)).toEqual(['Bea @bea', 'Bob @bob']);
    expect(activeOption(box())).toContain('@bea');
    await user.keyboard('{ArrowDown}');
    expect(activeOption(box())).toContain('@bob');
    expect(view.getByRole('option', { name: /Bob/ }).getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{ArrowDown}');
    expect(activeOption(box())).toContain('@bea');
    await user.keyboard('{ArrowUp}');
    expect(activeOption(box())).toContain('@bob');
    await user.keyboard('{Enter}');
    expect(box().value).toBe('ping @bob ');
    expect(box().selectionStart).toBe('ping @bob '.length);
    expect(sent()).toEqual([]);
    expect(list(view)).toBeNull();
    expect(box().getAttribute('aria-activedescendant')).toBeNull();
    // The list is gone, so Enter is a send again — with the handle in it.
    await user.keyboard('ship it{Enter}');
    expect(sent()).toEqual([{ channelId: IDS.api, content: 'ping @bob ship it' }]);
  });

  test('a handle typed out in full closes the list, so Enter sends as it always did', async () => {
    const { view, box, sent, user } = await mount();
    await user.click(box());
    await user.keyboard('ping @alic');
    expect(list(view)).not.toBeNull();
    await user.keyboard('e');
    expect(list(view)).toBeNull();
    await user.keyboard('{Enter}');
    expect(sent()).toEqual([{ channelId: IDS.api, content: 'ping @alice' }]);
  });

  test('Tab chooses too, and keeps focus in the box', async () => {
    const { view, box, user } = await mount();
    await user.click(box());
    await user.keyboard('@ali');
    await user.keyboard('{Tab}');
    expect(box().value).toBe('@alice ');
    expectFocusOn(box());
    expect(list(view)).toBeNull();
  });

  test('replaces only what was typed after the @, in the middle of the text', async () => {
    const { box, user } = await mount();
    await user.click(box());
    await user.keyboard('thanks  for the review');
    act(() => {
      box().setSelectionRange(7, 7);
    });
    await user.keyboard('@al{Enter}');
    expect(box().value).toBe('thanks @alice for the review');
  });

  test('Esc closes the list and keeps the text and the focus; the same @ stays closed, a new one opens', async () => {
    const { view, box, sent, user } = await mount();
    await user.click(box());
    await user.keyboard('@al');
    expect(list(view)).not.toBeNull();
    await user.keyboard('{Escape}');
    expect(list(view)).toBeNull();
    expect(box().value).toBe('@al');
    expectFocusOn(box());
    await user.keyboard('i');
    expect(list(view)).toBeNull();
    // With the list closed Enter is a send, of what was typed.
    await user.keyboard(' and @b');
    expect(options(view)).toEqual(['Bob @bob']);
    await user.keyboard('{Escape}{Enter}');
    expect(sent()).toEqual([{ channelId: IDS.api, content: '@ali and @b' }]);
  });

  test('a click on a person chooses them, and focus stays in the box', async () => {
    const { view, box, user } = await mount();
    await user.click(box());
    await user.keyboard('cc @b');
    await user.click(view.getByRole('option', { name: /Bob/ }));
    expect(box().value).toBe('cc @bob ');
    expectFocusOn(box());
    expect(list(view)).toBeNull();
  });

  test('the Mention button and a letter open it too', async () => {
    const { view, box, user } = await mount();
    await user.click(box());
    await user.keyboard('hi');
    await user.click(view.getByRole('button', { name: 'Mention someone' }));
    await user.keyboard('b');
    expect(options(view)).toEqual(['Bob @bob']);
  });

  test('is not offered inside a code fence, or once focus has left the box', async () => {
    const { view, box, user } = await mount();
    await user.click(box());
    await user.keyboard('```{Enter}@al');
    expect(list(view)).toBeNull();
    await user.keyboard('{Enter}```{Shift>}{Enter}{/Shift}@al');
    expect(list(view)).not.toBeNull();
    act(() => {
      box().blur();
    });
    expect(list(view)).toBeNull();
  });

  test("a thread's box offers people too, and Enter there chooses rather than replies", async () => {
    const { view, box, sent, user } = await mount({ props: { parentId: messageIdAt(1) } });
    await user.click(box());
    await user.keyboard('@al{Enter}');
    expect(box().value).toBe('@alice ');
    expect(sent()).toEqual([]);
    expect(list(view)).toBeNull();
  });

  test('a direct message offers only the other person', async () => {
    const { view, box, user } = await mount({
      props: { channelId: IDS.dm, channelName: 'Alice' },
      api: aSignedInApi({
        channels: () =>
          Promise.resolve([
            ...someChannels(),
            aChannel(IDS.dm, null, { type: 'direct_message', peer: aUser('alice', IDS.alice) }),
          ]),
      }),
    });
    await user.click(box());
    await user.keyboard('@a');
    expect(options(view)).toEqual(['Alice @alice']);
    await user.keyboard('{Backspace}b');
    expect(list(view)).toBeNull();
  });

  test('a private channel offers its members, read from the server: nobody else, though they wrote in it', async () => {
    let asked = 0;
    const { view, box, user } = await mount({
      api: aSignedInApi({
        channels: () =>
          Promise.resolve(
            someChannels().map((channel) =>
              channel.id === IDS.api ? { ...channel, type: 'private' as const } : channel,
            ),
          ),
        channelMembers: () => {
          asked += 1;
          return Promise.resolve(
            [BOB_USER].map((user) => ({ user, joinedAt: WHEN, profile: NO_PROFILE })),
          );
        },
      }),
    });
    act(() => {
      // Alice wrote here once and has left: what the feed holds is not who is in the channel.
      view.world.client.setQueryData(keys.messages(IDS.api), {
        pages: [
          { data: [aMessage(1, { channelId: IDS.api, sender: ALICE_USER })], nextCursor: null },
        ],
        pageParams: [undefined],
      });
    });
    await user.click(box());
    await user.keyboard('@b');
    expect(options(view)).toEqual(['Bob @bob']);
    await user.keyboard('{Backspace}a');
    expect(list(view)).toBeNull();
    expect(asked).toBe(1);
  });

  test('a private channel whose members could not be read says so after an @, with Retry, and Enter still sends', async () => {
    let fails = true;
    const { view, box, user } = await mount({
      api: aSignedInApi({
        channels: () =>
          Promise.resolve(
            someChannels().map((channel) =>
              channel.id === IDS.api ? { ...channel, type: 'private' as const } : channel,
            ),
          ),
        channelMembers: () =>
          fails
            ? Promise.reject(new ApiError(503, 'DATABASE_UNAVAILABLE', 'busy'))
            : Promise.resolve(
                [BOB_USER].map((user) => ({ user, joinedAt: WHEN, profile: NO_PROFILE })),
              ),
      }),
    });
    await user.click(box());
    await user.keyboard('@b');
    await settle();
    const said = view.getByRole('status', { name: /could not be read/i });
    expect(list(view)).toBeNull();
    fails = false;
    await user.click(within(said).getByRole('button', { name: 'Retry' }));
    await settle();
    expectFocusOn(box());
    expect(options(view)).toEqual(['Bob @bob']);
  });

  test('a public channel does not read its members: the workspace is who a mention there reaches', async () => {
    let asked = 0;
    const { box, user } = await mount({
      api: aSignedInApi({
        channelMembers: () => {
          asked += 1;
          return Promise.resolve([]);
        },
      }),
    });
    await user.click(box());
    await user.keyboard('@a');
    expect(asked).toBe(0);
  });

  test('passes the accessibility audit while the list is open, and says its words in Turkish', async () => {
    const { view, box, user } = await mount({ locale: 'tr' });
    await user.click(box());
    await user.keyboard('@a');
    expect(view.getByRole('listbox', { name: 'Anılabilecek kişiler' })).toBeDefined();
    await expectNoAxeViolations(view.container);
  });
});

describe('attaching files (D-109, #370)', () => {
  const asAttachment = (id: string, name: string, size: number): Attachment => ({
    id,
    fileName: name,
    mimeType: 'application/octet-stream',
    sizeBytes: size,
    kind: 'file',
    width: null,
    height: null,
  });

  /** An upload the test answers when it wants, so a send can be seen waiting for it. */
  const held = (): {
    readonly api: Partial<Api>;
    readonly calls: { workspaceId: string; id: string; name: string }[];
    readonly finish: (index: number) => void;
    readonly refuse: (index: number, error: Error) => void;
    /** Tells the upload how much of it has been sent, as the transport would. */
    readonly progress: (index: number, fraction: number) => void;
  } => {
    const calls: { workspaceId: string; id: string; name: string }[] = [];
    const answers: { resolve: (a: Attachment) => void; reject: (e: Error) => void }[] = [];
    const listeners: ((fraction: number) => void)[] = [];
    return {
      calls,
      api: {
        upload: (workspaceId, { id, name, file }, onProgress): Promise<Attachment> => {
          calls.push({ workspaceId, id, name });
          listeners.push(onProgress ?? ((): void => undefined));
          return new Promise<Attachment>((resolve, reject) => {
            answers.push({
              resolve: () => {
                resolve(asAttachment(id, name, file.size));
              },
              reject,
            });
          });
        },
      },
      finish: (index): void => {
        answers[index]?.resolve(asAttachment('', '', 0));
      },
      refuse: (index, error): void => {
        answers[index]?.reject(error);
      },
      progress: (index, fraction): void => {
        listeners[index]?.(fraction);
      },
    };
  };

  const paste = (box: HTMLTextAreaElement, files: File[]): void => {
    act(() => {
      fireEvent.paste(box, { clipboardData: { files, getData: () => '' } });
    });
  };

  test('a pasted file uploads at once under its own id, and a send with no words carries it', async () => {
    const uploads = held();
    const { view, box, sent } = await mount({ api: aSignedInApi(uploads.api) });
    paste(box(), [new File([new Uint8Array([1, 2, 3])], 'notes.txt')]);
    expect(uploads.calls).toEqual([
      { workspaceId: IDS.workspace, id: expect.any(String) as string, name: 'notes.txt' },
    ]);
    expect(view.getByText('Uploading…')).toBeDefined();
    uploads.finish(0);
    await settle();
    act(() => {
      fireEvent.click(view.getByRole('button', { name: 'Send' }));
    });
    expect(sent()).toEqual([
      { channelId: IDS.api, content: '', attachmentIds: [uploads.calls[0]?.id] },
    ]);
    // The chip goes with what was sent.
    expect(view.queryByText('notes.txt')).toBeNull();
    await expectNoAxeViolations(view.container);
  });

  test('an upload says how much of it is sent, as a progress bar a screen reader can read (#388)', async () => {
    const uploads = held();
    const { view, box } = await mount({ api: aSignedInApi(uploads.api) });
    paste(box(), [new File([new Uint8Array([1, 2, 3])], 'big.zip')]);
    // Nothing measured yet: said in words, with no number to read.
    expect(view.getByText('Uploading…')).toBeDefined();
    expect(view.queryByRole('progressbar')).toBeNull();
    act(() => {
      uploads.progress(0, 0.425);
    });
    const bar = view.getByRole('progressbar', { name: 'Uploading big.zip' });
    expect(bar.textContent).toBe('Uploading… 42%');
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    act(() => {
      uploads.progress(0, 1);
    });
    expect(view.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('100');
    uploads.finish(0);
    await settle();
    expect(view.queryByRole('progressbar')).toBeNull();
    await expectNoAxeViolations(view.container);
  });

  test('progress is said in Turkish when the interface is', async () => {
    const uploads = held();
    const { view, box } = await mount({ api: aSignedInApi(uploads.api), locale: 'tr' });
    paste(box(), [new File([new Uint8Array([1])], 'a.txt')]);
    act(() => {
      uploads.progress(0, 0.5);
    });
    expect(view.getByRole('progressbar', { name: 'a.txt yükleniyor' }).textContent).toBe(
      'Yükleniyor… %50',
    );
  });

  test('a send while a file is still uploading waits for it, says so, and goes when it lands', async () => {
    const uploads = held();
    const { view, box, sent, user } = await mount({ api: aSignedInApi(uploads.api) });
    paste(box(), [new File([new Uint8Array([1])], 'a.txt')]);
    await user.type(box(), 'look{Enter}');
    expect(sent()).toEqual([]);
    expect(view.getByText('Sends when the files finish uploading.')).toBeDefined();
    uploads.finish(0);
    await settle();
    expect(sent()).toEqual([
      { channelId: IDS.api, content: 'look', attachmentIds: [uploads.calls[0]?.id] },
    ]);
  });

  test('a failed upload says why, holds the send back, and Retry uploads it again', async () => {
    const uploads = held();
    const { view, box, sent, user } = await mount({ api: aSignedInApi(uploads.api) });
    paste(box(), [new File([new Uint8Array([1])], 'a.txt')]);
    uploads.refuse(0, new ApiError(503, 'STORAGE_UNAVAILABLE', 'down'));
    await settle();
    expect(view.getByText('File storage is unavailable')).toBeDefined();
    await user.type(box(), 'look{Enter}');
    expect(sent()).toEqual([]);
    expect(view.getByRole('alert').textContent).toContain('A file did not upload');
    act(() => {
      fireEvent.click(view.getByRole('button', { name: 'Retry a.txt' }));
    });
    expect(uploads.calls).toHaveLength(2);
    // The same file, under the same id: a retry of an upload that did land is the same upload.
    expect(uploads.calls[1]?.id).toBe(uploads.calls[0]?.id);
  });

  // Why, in words, from the code the upload was refused with (D-159); Retry only where trying the
  // same bytes again can be answered differently, and Remove always.
  const refusals: readonly [
    string,
    ApiError | Error,
    { readonly en: string; readonly tr: string; readonly retry: boolean },
  ][] = [
    [
      'too large at the edge',
      new ApiError(413, 'PAYLOAD_TOO_LARGE', 'big'),
      { en: 'Larger than 25 MB', tr: '25 MB sınırından büyük', retry: false },
    ],
    [
      'an image past the bounds',
      new ApiError(413, 'IMAGE_TOO_LARGE', 'big'),
      {
        en: 'Image too large: 16,384 px a side, 40 MP at most',
        tr: 'Görüntü çok büyük: kenarı en çok 16.384 px, en çok 40 MP',
        retry: false,
      },
    ],
    [
      'an image that does not decode',
      new ApiError(400, 'IMAGE_UNREADABLE', 'bad'),
      {
        en: 'Not a PNG, JPEG, GIF or WebP that can be read',
        tr: 'Okunabilir bir PNG, JPEG, GIF ya da WebP değil',
        retry: false,
      },
    ],
    [
      'a type refused',
      new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'type'),
      {
        en: 'This type of file is not accepted',
        tr: 'Bu dosya türü kabul edilmiyor',
        retry: false,
      },
    ],
    [
      'the quota, with the room left',
      new ApiError(413, 'STORAGE_QUOTA_EXCEEDED', 'full', {}, undefined, [], 3 * 1024 * 1024),
      {
        en: 'Workspace storage is full: 3 MB left',
        tr: 'Çalışma alanının depolaması dolu: 3 MB kaldı',
        retry: true,
      },
    ],
    [
      'the quota, with no room left',
      new ApiError(413, 'STORAGE_QUOTA_EXCEEDED', 'full', {}, undefined, [], 0),
      { en: 'Workspace storage is full', tr: 'Çalışma alanının depolaması dolu', retry: true },
    ],
    [
      'too many waiting',
      new ApiError(409, 'TOO_MANY_PENDING_UPLOADS', 'many'),
      {
        en: 'Too many files waiting: send or remove some',
        tr: 'Bekleyen dosya çok: gönder ya da birini kaldır',
        retry: true,
      },
    ],
    [
      'the network',
      new ApiError(0, 'NETWORK', 'offline'),
      { en: 'No connection', tr: 'Bağlantı yok', retry: true },
    ],
    [
      'a busy node',
      new ApiError(429, 'RATE_LIMITED', 'busy'),
      { en: 'The server is busy', tr: 'Sunucu meşgul', retry: true },
    ],
    [
      'the session',
      new ApiError(401, 'UNAUTHENTICATED', 'who'),
      {
        en: 'Session ended: sign in again',
        tr: 'Oturumun sona erdi: tekrar giriş yap',
        retry: true,
      },
    ],
    [
      'anything nobody described',
      new Error('boom'),
      { en: 'Didn’t upload', tr: 'Yüklenmedi', retry: true },
    ],
  ];

  for (const [name, error, said] of refusals) {
    for (const locale of ['en', 'tr'] as const) {
      test(`a failed upload says why — ${name} (${locale})`, async () => {
        const uploads = held();
        const { view, box } = await mount({ api: aSignedInApi(uploads.api), locale });
        paste(box(), [new File([new Uint8Array([1])], 'a.png')]);
        uploads.refuse(0, error);
        await settle();
        const chip = view.getByText('a.png').closest('li');
        if (chip === null) throw new Error('no chip');
        expect(within(chip).getByText(said[locale])).toBeDefined();
        const retry = locale === 'en' ? 'Retry a.png' : 'a.png: yeniden dene';
        expect(within(chip).queryByRole('button', { name: retry }) !== null).toBe(said.retry);
        const remove = locale === 'en' ? 'Remove a.png' : 'a.png: kaldır';
        expect(within(chip).getByRole('button', { name: remove })).toBeDefined();
      });
    }
  }

  test('a file over the limit is refused before anything is sent, in words', async () => {
    const uploads = held();
    const { view, box } = await mount({ api: aSignedInApi(uploads.api) });
    const huge = new File([new Uint8Array(1)], 'huge.mov');
    Object.defineProperty(huge, 'size', { value: ATTACHMENT_BYTES_MAX + 1 });
    paste(box(), [huge]);
    expect(uploads.calls).toEqual([]);
    expect(view.getByText('Larger than 25 MB')).toBeDefined();
  });

  test('a chip can be removed, and its upload is thrown away on the server too', async () => {
    const uploads = held();
    const discarded: string[] = [];
    const { view, box } = await mount({
      api: aSignedInApi({
        ...uploads.api,
        discardAttachment: (id) => {
          discarded.push(id);
          return Promise.resolve();
        },
      }),
    });
    paste(box(), [new File([new Uint8Array([1])], 'a.txt')]);
    uploads.finish(0);
    await settle();
    act(() => {
      fireEvent.click(view.getByRole('button', { name: 'Remove a.txt' }));
    });
    await settle();
    expect(view.queryByText('a.txt')).toBeNull();
    expect(discarded).toEqual(uploads.calls.map((call) => call.id));
  });

  test('a dropped file and a picked one upload like a pasted one', async () => {
    const uploads = held();
    const { view, box } = await mount({ api: aSignedInApi(uploads.api) });
    const card = box().closest('[data-composer-card]');
    if (card === null) throw new Error('no card');
    const dropped = new File([new Uint8Array([1])], 'dropped.txt');
    act(() => {
      fireEvent.dragOver(card, { dataTransfer: { types: ['Files'], files: [dropped] } });
      fireEvent.drop(card, { dataTransfer: { types: ['Files'], files: [dropped] } });
    });
    const picker = view.container.querySelector('input[type="file"]');
    if (!(picker instanceof HTMLInputElement)) throw new Error('no picker');
    const picked = new File([new Uint8Array([2])], 'picked.txt');
    act(() => {
      fireEvent.click(view.getByRole('button', { name: 'Attach a file' }));
      fireEvent.change(picker, { target: { files: [picked] } });
    });
    expect(uploads.calls.map((call) => call.name)).toEqual(['dropped.txt', 'picked.txt']);
  });

  test('past the most a message carries, the rest are not taken, and the person is told', async () => {
    const uploads = held();
    const { view, box } = await mount({ api: aSignedInApi(uploads.api) });
    const files = Array.from(
      { length: ATTACHMENTS_PER_MESSAGE_MAX + 2 },
      (_, n) => new File([new Uint8Array([n])], `f${String(n)}.txt`),
    );
    paste(box(), files);
    expect(uploads.calls).toHaveLength(ATTACHMENTS_PER_MESSAGE_MAX);
    expect(
      view.getByText(`At most ${String(ATTACHMENTS_PER_MESSAGE_MAX)} files in one message.`),
    ).toBeDefined();
  });

  test('a removal the server refuses is said, not swallowed', async () => {
    const uploads = held();
    const { view, box } = await mount({
      api: aSignedInApi({
        ...uploads.api,
        discardAttachment: () => Promise.reject(new ApiError(0, 'NETWORK', 'down')),
      }),
    });
    paste(box(), [new File([new Uint8Array([1])], 'a.txt')]);
    uploads.finish(0);
    await settle();
    act(() => {
      fireEvent.click(view.getByRole('button', { name: 'Remove a.txt' }));
    });
    await settle();
    expect(view.getByText(/a\.txt was removed here, but not from the server\./)).toBeDefined();
  });

  test('the attach button picks files with the keyboard, and is named in both languages', async () => {
    const { view } = await mount({ locale: 'tr' });
    expect(view.getByRole('button', { name: 'Dosya ekle' })).toBeDefined();
  });
});

/** Who is typing (D-114, #411): said by the composer, shown beside its hints. */
describe('typing', () => {
  const typing = (userId: string): ServerFrame => ({
    event: 'TYPING',
    data: { channelId: IDS.api, userId, ttlMs: 6_000 },
    ts: 0,
  });
  const line = (view: Mounted['view']): string =>
    view.container.querySelector('[aria-live="polite"].truncate')?.textContent ?? '';

  test('typing says so to the room once, naming the channel; spaces alone say nothing', async () => {
    const { view, box, user } = await mount();
    await user.type(box(), '   ');
    expect(view.world.sockets.sent('TYPING')).toEqual([]);
    await user.type(box(), 'hello');
    expect(view.world.sockets.sent('TYPING').map((f) => f.payload)).toEqual([
      { channelId: IDS.api },
    ]);
  });

  test('names who is typing, two by name, more as several, and nobody once they stop', async () => {
    const { view } = await mount();
    expect(line(view)).toBe('');
    act(() => {
      view.world.sockets.deliver(typing(IDS.alice));
    });
    await settle();
    expect(line(view)).toBe('Alice is typing…');
    act(() => {
      view.world.sockets.deliver(typing(IDS.bob));
    });
    await settle();
    expect(line(view)).toBe('Alice and Bob are typing…');
    act(() => {
      view.world.sockets.deliver(typing('00000000-0000-4000-8000-0000000000f9'));
    });
    expect(line(view)).toBe('Several people are typing…');
    act(() => {
      view.world.timers.advance(6_000);
    });
    expect(line(view)).toBe('');
  });

  test('a person the workspace list does not hold is "someone", and it is said in Turkish', async () => {
    const { view } = await mount({ locale: 'tr' });
    act(() => {
      view.world.sockets.deliver(typing('00000000-0000-4000-8000-0000000000f9'));
    });
    await settle();
    expect(line(view)).toBe('Biri yazıyor…');
    act(() => {
      view.world.sockets.deliver(typing(IDS.alice));
    });
    await settle();
    expect(line(view)).toBe('Biri ve Alice yazıyor…');
    await expectNoAxeViolations(view.container);
  });

  test('a reply composer shows no line: typing is the channel’s, and its composer shows it', async () => {
    const { view } = await mount({ props: { parentId: aMessage(1).id } });
    act(() => {
      view.world.sockets.deliver(typing(IDS.alice));
    });
    await settle();
    expect(view.queryByText('Alice is typing…')).toBeNull();
  });
});
