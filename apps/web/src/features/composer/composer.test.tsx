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
import { OutboxProvider } from './uploads';
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
  /** A device with no pointer that hovers: a phone. */
  readonly touchOnly?: boolean;
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
  /** Takes the composer off the page and puts it back, as closing and opening a thread's panel does. */
  readonly shown: (shown: boolean) => void;
}

const mount = async (options: Options = {}): Promise<Mounted> => {
  const timers = fakeSchedule();
  const storage = options.storage === undefined ? memory() : options.storage;
  let props: ComposerProps = { channelId: IDS.api, channelName: 'api', ...options.props };
  let setProps: (next: ComposerProps) => void = () => undefined;
  let setShown: (next: boolean) => void = () => undefined;
  /** Holds the composer's props in state, so a test can change them the way a route change does. */
  const Holder = (): React.JSX.Element | null => {
    const [current, set] = useState(props);
    const [visible, show] = useState(true);
    setProps = set;
    setShown = show;
    return visible ? <Composer {...current} /> : null;
  };
  const tree = (): React.ReactElement => (
    <SessionGate>
      <WorkspaceScopeProvider slug="acme" notFound={null}>
        <RealtimeProvider>
          <OutboxProvider>
            <ComposerPortsContext.Provider
              value={{
                storage,
                schedule: timers.schedule,
                touchOnly: () => options.touchOnly === true,
              }}
            >
              <Holder />
            </ComposerPortsContext.Provider>
          </OutboxProvider>
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
    shown: (next): void => {
      act(() => {
        setShown(next);
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
  test('names where it writes in Turkish without a suffix to agree with a channel or a person', async () => {
    const { box } = await mount({
      locale: 'tr',
      props: { channelId: IDS.api, channelName: 'Alice Chen' },
    });
    expect(box().getAttribute('placeholder')).toBe('Mesaj yaz: Alice Chen');
  });

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
    // The line that divides the buttons from the hints comes with them, and like them is not on a phone.
    const divider = (): Element | null => view.container.querySelector('[data-hints-divider]');
    expect(divider()).toBeNull();
    await user.click(box());
    expect(divider()?.className.split(' ')).toContain('max-narrow:hidden');
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
    expect(view.getByRole('textbox', { name: 'Mesaj: api' })).toBeDefined();
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

  test('thirteen lines become a code block on its own line, and Undo keeps the pasted text', async () => {
    const { view, box, user } = await mount();
    await user.type(box(), 'before ');
    await user.paste(thirteen);
    // A fence opens a line or it is not one: after words, it starts on the next (D-210).
    expect(box().value).toBe(`before \n\`\`\`\n${thirteen}\n\`\`\``);
    expect(view.getByText('Pasted text became a code block')).toBeDefined();
    await user.click(view.getByRole('button', { name: 'Undo' }));
    expect(box().value).toBe(`before ${thirteen}`);
    expectFocusOn(box());
  });

  test('replaces the selection, not the whole text, and the caret lands after the block', async () => {
    const { box, user } = await mount();
    await user.type(box(), 'keep SELECT keep');
    box().setSelectionRange(5, 11);
    await user.paste(thirteen);
    expect(box().value).toBe(`keep \n\`\`\`\n${thirteen}\n\`\`\`\n keep`);
    expect(box().selectionStart).toBe(`keep \n\`\`\`\n${thirteen}\n\`\`\`\n`.length);
  });

  test.each(['~~~ts\n', '```ts\n'])(
    'a paste inside %j keeps the existing fence',
    async (opening) => {
      const { view, box, user } = await mount();
      await user.type(box(), opening);
      await user.paste(thirteen);
      expect(box().value).toBe(opening + thirteen);
      expect(view.queryByText('Pasted text became a code block')).toBeNull();
    },
  );

  test('already fenced pasted code stays as supplied', async () => {
    const { view, box, user } = await mount();
    await user.click(box());
    await user.paste(`\`\`\`ts\n${thirteen}\n\`\`\``);
    expect(box().value).toBe(`\`\`\`ts\n${thirteen}\n\`\`\``);
    expect(view.queryByText('Pasted text became a code block')).toBeNull();
  });

  test('Undo removes automatic formatting without erasing text added after the paste', async () => {
    const { view, box, user } = await mount();
    await user.click(box());
    await user.paste(thirteen);
    await user.type(box(), 'after');
    await user.click(view.getByRole('button', { name: 'Undo' }));
    expect(box().value).toBe(`${thirteen}after`);
  });

  test('Undo preserves a pasted block that has since been edited', async () => {
    const { view, box, user } = await mount();
    await user.click(box());
    await user.paste(thirteen);
    const edited = box().value.replace('line 0', 'my edit');
    box().setSelectionRange(4, 10);
    await press(user, 'my edit');
    await user.click(view.getByRole('button', { name: 'Undo' }));
    expect(box().value).toBe(edited);
    expect(view.getByText('The pasted block changed. Your edits were kept.')).toBeDefined();
  });

  test('twelve lines are an ordinary paste, left to the browser, with no toast', async () => {
    const { view, box } = await mount();
    const twelve = thirteen.split('\n').slice(0, 12).join('\n');
    expect(fireEvent.paste(box(), { clipboardData: { getData: () => twelve } })).toBe(true);
    expect(view.queryByText('Pasted text became a code block')).toBeNull();
  });

  /** A paste as a browser makes one: the plain words, and what else the source put on the clipboard. */
  const pasteOf = (target: HTMLElement, plain: string, html = ''): boolean =>
    fireEvent.paste(target, {
      clipboardData: {
        files: [],
        getData: (type: string) => (type === 'text/html' ? html : plain),
      },
    });

  test('a spreadsheet’s rows become a table on lines of their own, and Paste as text undoes it (D-210)', async () => {
    const { view, box, user } = await mount();
    await user.type(box(), 'Numbers:');
    const rows = 'Region\tQ1\nİstanbul\t12';
    act(() => {
      pasteOf(box(), rows);
    });
    expect(box().value).toBe('Numbers:\n| Region | Q1 |\n| --- | --- |\n| İstanbul | 12 |');
    expect(view.getByText('Pasted rows became a table')).toBeDefined();
    await user.click(view.getByRole('button', { name: 'Paste as text' }));
    expect(box().value).toBe(`Numbers:${rows}`);
    expectFocusOn(box());
  });

  test('formatted text from a page keeps its emphasis and links, inline where the caret is', async () => {
    const { view, box, user } = await mount();
    await user.type(box(), 'See ');
    act(() => {
      pasteOf(
        box(),
        'the PR now',
        '<span>the <a href="https://example.com/pr/1">PR</a> <b>now</b></span>',
      );
    });
    expect(box().value).toBe('See the [PR](https://example.com/pr/1) **now**');
    expect(view.getByText('Pasted text kept its formatting')).toBeDefined();
  });

  test('Mod+Shift+V pastes the words as they are: no table, no formatting, no block', async () => {
    const { view, box, user } = await mount();
    await user.click(box());
    fireEvent.keyDown(box(), { key: 'V', metaKey: true, shiftKey: true });
    expect(pasteOf(box(), 'a\tb\nc\td', '<b>a</b>')).toBe(true);
    expect(view.queryByText('Pasted rows became a table')).toBeNull();
    // Only that paste: the next one is read again.
    act(() => {
      pasteOf(box(), 'a\tb\nc\td');
    });
    expect(view.getByText('Pasted rows became a table')).toBeDefined();
  });

  test('a long paste of code is a block in its language, so it is coloured', async () => {
    const { box } = await mount();
    const code = [
      'export interface Policy {',
      ...Array.from({ length: 12 }, (_, n) => `  readonly a${String(n)}: number;`),
      '}',
    ].join('\n');
    act(() => {
      pasteOf(box(), code);
    });
    expect(box().value).toBe(`\`\`\`ts\n${code}\n\`\`\``);
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
      expect(card?.contains(view.getByRole('button', { name }))).toBe(true);
    }
    // Bold is the formatting row's one Tab stop; Code block is reached from it by the arrows.
    expect(view.getByRole('button', { name: 'Bold' }).getAttribute('tabindex')).toBe('0');
    expect(view.getByRole('button', { name: 'Mention someone' }).getAttribute('tabindex')).not.toBe(
      '-1',
    );
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

describe('the formatting row: every construct the renderer draws (D-110, D-181)', () => {
  const FORMATTING = [
    'Bold',
    'Italic',
    'Strikethrough',
    'Code',
    'Link',
    'Bulleted list',
    'Numbered list',
    'Quote',
    'Code block',
    'Table',
  ] as const;

  test('is there, in the channel and in a thread alike, each button named and reachable by Tab', async () => {
    const channel = await mount();
    const card = channel.view.container.querySelector('[data-composer-card]');
    for (const name of [
      ...FORMATTING,
      'Preview',
      'Mention someone',
      'Add an emoji',
      'Attach a file',
    ]) {
      expect(card?.contains(channel.view.getByRole('button', { name }))).toBe(true);
    }
    // The row is one Tab stop (a toolbar): the rest are reached by the arrows, so a keyboard walk
    // from the feed to the box is not eleven presses longer than it was.
    const toolbar = channel.view.getByRole('toolbar', { name: 'Formatting' });
    const stops = within(toolbar)
      .getAllByRole('button')
      .filter((button) => button.getAttribute('tabindex') !== '-1');
    expect(stops.map((button) => button.getAttribute('aria-label'))).toEqual(['Bold']);
    channel.view.unmount();
    const thread = await mount({ props: { parentId: messageIdAt(1) } });
    for (const name of FORMATTING) {
      expect(thread.view.getByRole('button', { name })).toBeDefined();
    }
  });

  test('the arrows move along the row, Home and End go to its ends, and Tab leaves it by the button last used', async () => {
    const { view, user } = await mount();
    const toolbar = view.getByRole('toolbar', { name: 'Formatting' });
    const bold = within(toolbar).getByRole('button', { name: 'Bold' });
    const italic = within(toolbar).getByRole('button', { name: 'Italic' });
    const preview = within(toolbar).getByRole('button', { name: 'Preview' });
    const codeBlock = within(toolbar).getByRole('button', { name: 'Code block' });
    act(() => {
      bold.focus();
    });
    await user.keyboard('{ArrowRight}');
    expectFocusOn(italic);
    await user.keyboard('{ArrowLeft}');
    expectFocusOn(bold);
    await user.keyboard('{End}');
    expectFocusOn(preview);
    await user.keyboard('{ArrowRight}');
    expectFocusOn(bold);
    await user.keyboard('{ArrowLeft}');
    expectFocusOn(preview);
    await user.keyboard('{Home}');
    expectFocusOn(bold);
    // The stop follows the focus: back in the row, Tab lands where it was left.
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(italic.getAttribute('tabindex')).toBe('-1');
    expect(
      within(toolbar).getByRole('button', { name: 'Strikethrough' }).getAttribute('tabindex'),
    ).toBe('0');
    expect(codeBlock.getAttribute('tabindex')).toBe('-1');
  });

  const typed = async (
    text: string,
    from: number,
    to: number,
  ): Promise<Awaited<ReturnType<typeof mount>>> => {
    const mounted = await mount();
    await mounted.user.click(mounted.box());
    await mounted.user.keyboard(text.replaceAll('\n', '{Shift>}{Enter}{/Shift}'));
    act(() => {
      mounted.box().setSelectionRange(from, to);
    });
    return mounted;
  };

  test.each([
    ['Italic', 'fix it', 4, 6, 'fix _it_'],
    ['Strikethrough', 'fix it', 4, 6, 'fix ~~it~~'],
    ['Code', 'fix it', 4, 6, 'fix `it`'],
    ['Link', 'see docs', 4, 8, 'see [docs](https://)'],
    ['Bulleted list', 'one\ntwo', 0, 7, '- one\n- two'],
    ['Numbered list', 'one\ntwo', 0, 7, '1. one\n2. two'],
    ['Quote', 'one', 0, 3, '> one'],
  ] as const)(
    '%s inserts its markdown and keeps the box focused',
    async (name, text, from, to, expected) => {
      const { view, box, user } = await typed(text, from, to);
      await user.click(view.getByRole('button', { name }));
      expect(box().value).toBe(expected);
      expectFocusOn(box());
    },
  );

  test('a second press takes the markers off again', async () => {
    const { view, box, user } = await typed('fix it', 4, 6);
    await user.click(view.getByRole('button', { name: 'Italic' }));
    await user.click(view.getByRole('button', { name: 'Italic' }));
    expect(box().value).toBe('fix it');
  });

  test.each([
    ['{Control>}b{/Control}', 'fix **it**'],
    ['{Meta>}b{/Meta}', 'fix **it**'],
    ['{Control>}i{/Control}', 'fix _it_'],
    ['{Control>}e{/Control}', 'fix `it`'],
    ['{Control>}{Shift>}x{/Shift}{/Control}', 'fix ~~it~~'],
    ['{Control>}{Shift>}u{/Shift}{/Control}', 'fix [it](https://)'],
  ])('the key %s does what its button does', async (keys, expected) => {
    const { box, user } = await typed('fix it', 4, 6);
    await user.keyboard(keys);
    expect(box().value).toBe(expected);
    expect(document.activeElement === box()).toBe(true);
  });

  test.each([
    ['Digit8', '- one'],
    ['Digit7', '1. one'],
    ['Digit9', '> one'],
  ])(
    'Ctrl+Shift+%s marks lines, whichever character the layout puts on that key',
    async (code, expected) => {
      const { box } = await typed('one', 0, 3);
      fireEvent.keyDown(box(), { code, key: '*', ctrlKey: true, shiftKey: true });
      expect(box().value).toBe(expected);
    },
  );

  test('a formatting key sends nothing and leaves the browser its own meaning of nothing', async () => {
    const { box, user, sent } = await typed('x', 0, 1);
    await user.keyboard('{Control>}b{/Control}');
    expect(sent()).toEqual([]);
    expect(box().value).toBe('**x**');
  });

  test('a key with Alt, or without Ctrl or Meta, is only typing', async () => {
    const { box, user } = await typed('x', 1, 1);
    await user.keyboard('b');
    await user.keyboard('{Alt>}i{/Alt}');
    expect(box().value).toBe('xb');
  });

  test("inside a code fence the formatting keys still work: it is the person's box", async () => {
    const { box, user } = await typed('```\nfix it', 8, 10);
    await user.keyboard('{Control>}b{/Control}');
    expect(box().value).toBe('```\nfix **it**');
  });
});

describe('the emoji picker (D-181)', () => {
  test('offers groups of emoji, each one named for what it is by the emoji itself, and writes the one chosen at the caret', async () => {
    const { view, box, user } = await mount();
    await user.click(box());
    await user.keyboard('ship it now');
    act(() => {
      box().setSelectionRange(7, 7);
    });
    await user.click(view.getByRole('button', { name: 'Add an emoji' }));
    // Groups, so the grid is read in pieces.
    for (const group of ['Faces', 'Hands and people', 'Work', 'Symbols']) {
      expect(view.getByText(group)).toBeDefined();
    }
    await user.click(view.getByRole('menuitemcheckbox', { name: '🚀' }));
    expect(box().value).toBe('ship it🚀 now');
    // Where the person was writing, not on the button that opened the picker.
    expectFocusOn(box());
    expect(box().selectionStart).toBe(7 + '🚀'.length);
  });

  test('is a grid: ← → step one tile, ↑ ↓ step a row of eight, and a row past the group is left to the menu', async () => {
    const { view, box, user } = await mount();
    await user.click(box());
    await user.click(view.getByRole('button', { name: 'Add an emoji' }));
    const tiles = view.getAllByRole('menuitemcheckbox').slice(0, 16);
    const [first, second, , , , , , , ninth] = tiles;
    if (first === undefined || second === undefined || ninth === undefined) {
      throw new Error('the picker has no tiles');
    }
    act(() => {
      first.focus();
    });
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expectFocusOn(second);
    fireEvent.keyDown(second, { key: 'ArrowLeft' });
    expectFocusOn(first);
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expectFocusOn(ninth);
    fireEvent.keyDown(ninth, { key: 'ArrowUp' });
    expectFocusOn(first);
    // Up from the top row does not wrap round to the bottom row.
    fireEvent.keyDown(first, { key: 'ArrowUp' });
    expect(ninth.matches(':focus')).toBe(false);
  });

  test('what it writes is a draft like any other, and sends as typed', async () => {
    const { view, box, user, sent } = await mount();
    await user.click(box());
    await user.click(view.getByRole('button', { name: 'Add an emoji' }));
    await user.click(view.getByRole('menuitemcheckbox', { name: '✅' }));
    await user.keyboard(' done{Enter}');
    expect(sent().map((frame) => frame.content)).toEqual(['✅ done']);
  });

  test('Escape closes it and gives the focus back to the box, with nothing written', async () => {
    const { view, box, user } = await mount();
    await user.click(box());
    await user.keyboard('x');
    await user.click(view.getByRole('button', { name: 'Add an emoji' }));
    await user.keyboard('{Escape}');
    expect(view.queryByRole('menuitemcheckbox', { name: '🚀' })).toBeNull();
    expectFocusOn(box());
    expect(box().value).toBe('x');
  });
});

describe('Shift+Enter in a list carries it on; Enter still sends (D-181)', () => {
  test('a bulleted line is followed by a bulleted one', async () => {
    const { box, user, sent } = await mount();
    await user.click(box());
    await user.keyboard('- one{Shift>}{Enter}{/Shift}two');
    expect(box().value).toBe('- one\n- two');
    expect(sent()).toEqual([]);
  });

  test('a numbered line is followed by the next number, and an empty item ends the list', async () => {
    const { box, user } = await mount();
    await user.click(box());
    await user.keyboard('1. a{Shift>}{Enter}{/Shift}b{Shift>}{Enter}{/Shift}');
    expect(box().value).toBe('1. a\n2. b\n3. ');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(box().value).toBe('1. a\n2. b\n');
  });

  test('Enter in a list sends it, as it does anywhere', async () => {
    const { box, user, sent } = await mount();
    await user.click(box());
    await user.keyboard('- one{Enter}');
    expect(sent().map((frame) => frame.content)).toEqual(['- one']);
  });

  test('in a code fence a dash is not a list: Shift+Enter is the ordinary line break', async () => {
    const { box, user } = await mount();
    await user.click(box());
    await user.keyboard('```{Shift>}{Enter}{/Shift}- x{Shift>}{Enter}{/Shift}');
    expect(box().value).toBe('```\n- x\n');
  });
});

describe('Enter, Shift+Enter and code (D-188)', () => {
  test('inside an open fence a plain Enter is a new line and sends nothing', async () => {
    const { box, user, sent } = await mount();
    await user.click(box());
    await user.keyboard('```ts{Enter}let a = 1;{Enter}let b = 2;');
    expect(box().value).toBe('```ts\nlet a = 1;\nlet b = 2;');
    expect(sent()).toEqual([]);
  });

  test('Ctrl+Enter sends from inside the fence, the whole block as written', async () => {
    const { box, user, sent } = await mount();
    await user.click(box());
    await user.keyboard('```{Enter}x{Control>}{Enter}{/Control}');
    expect(sent().map((frame) => frame.content)).toEqual(['```\nx']);
  });

  test('once the fence is closed, Enter sends again', async () => {
    const { box, user, sent } = await mount();
    await user.click(box());
    await user.keyboard('```{Enter}x{Enter}```{Enter}');
    expect(sent().map((frame) => frame.content)).toEqual(['```\nx\n```']);
  });

  test('Shift+Enter in a quote carries the marker on', async () => {
    const { box, user, sent } = await mount();
    await user.click(box());
    await user.keyboard('> said{Shift>}{Enter}{/Shift}more');
    expect(box().value).toBe('> said\n> more');
    expect(sent()).toEqual([]);
  });

  test('while the caret is in an open fence the hint names the key that sends', async () => {
    const { box, user } = await mount();
    await user.click(box());
    const hint = (): string =>
      document.getElementById(box().getAttribute('aria-describedby') ?? '')?.textContent ?? '';
    expect(hint()).toContain('Enter');
    expect(hint()).not.toContain('Ctrl+Enter');
    await user.keyboard('```{Enter}x');
    expect(hint()).toContain('Ctrl+Enter');
    await user.keyboard('{Enter}```');
    expect(hint()).not.toContain('Ctrl+Enter');
  });

  test('the code block chord opens a fence round the selection, whatever Alt makes of the letter', async () => {
    const { box, user } = await mount();
    await user.click(box());
    await user.keyboard('fix it');
    act(() => {
      box().setSelectionRange(4, 6);
    });
    // Built by hand: happy-dom answers `getModifierState('AltGraph')` with `altKey`, which no browser does.
    const chord = new KeyboardEvent('keydown', {
      key: 'ç',
      code: 'KeyC',
      metaKey: true,
      altKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(chord, 'getModifierState', { value: () => false });
    act(() => {
      box().dispatchEvent(chord);
    });
    expect(box().value).toBe('fix \n```\nit\n```');
  });

  test('a backtick typed over a selection wraps it instead of replacing it', async () => {
    const { box, user, sent } = await mount();
    await user.click(box());
    await user.keyboard('fix it');
    act(() => {
      box().setSelectionRange(4, 6);
    });
    fireEvent.keyDown(box(), { key: '`', code: 'Backquote' });
    expect(box().value).toBe('fix `it`');
    expect(sent()).toEqual([]);
  });

  test('a backtick with nothing selected is only typing', async () => {
    const { box, user } = await mount();
    await user.click(box());
    await user.keyboard('a`b');
    expect(box().value).toBe('a`b');
  });
});

describe('on a phone (D-188)', () => {
  test('Enter is a line break, because there is no Shift+Enter, and the Send button sends', async () => {
    const { view, box, user, sent } = await mount({ touchOnly: true });
    await user.click(box());
    await user.keyboard('one{Enter}two');
    expect(box().value).toBe('one\ntwo');
    expect(sent()).toEqual([]);
    await user.click(view.getByRole('button', { name: /Send/ }));
    expect(sent().map((frame) => frame.content)).toEqual(['one\ntwo']);
  });

  test('a keyboard that is attached still sends with Ctrl+Enter', async () => {
    const { box, user, sent } = await mount({ touchOnly: true });
    await user.click(box());
    await user.keyboard('one{Control>}{Enter}{/Control}');
    expect(sent().map((frame) => frame.content)).toEqual(['one']);
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

  test.each([false, true])(
    'an attachment-only send is enabled and clickable (touch only: %s)',
    async (touchOnly) => {
      const uploads = held();
      const { view, box, sent, user } = await mount({ api: aSignedInApi(uploads.api), touchOnly });
      expect(view.getByRole('button', { name: 'Send' }).getAttribute('aria-disabled')).toBe('true');
      paste(box(), [new File([new Uint8Array([1, 2, 3])], 'notes.txt')]);
      expect(uploads.calls).toEqual([
        { workspaceId: IDS.workspace, id: expect.any(String) as string, name: 'notes.txt' },
      ]);
      expect(view.getByText('Uploading…')).toBeDefined();
      uploads.finish(0);
      await settle();
      expect(view.getByRole('button', { name: 'Send' }).getAttribute('aria-disabled')).toBe(
        'false',
      );
      await user.click(view.getByRole('button', { name: 'Send' }));
      expect(view.getByRole('button', { name: 'Send' }).getAttribute('aria-disabled')).toBe('true');
      expect(sent()).toEqual([
        { channelId: IDS.api, content: '', attachmentIds: [uploads.calls[0]?.id] },
      ]);
      // The chip goes with what was sent.
      expect(view.queryByText('notes.txt')).toBeNull();
      await expectNoAxeViolations(view.container);
    },
  );

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

  // A send that is waiting on its files belongs to where it was written, not to the composer on the
  // screen: leaving the channel, or closing a thread's panel, neither sends it early nor loses it.
  test('a send waiting on its files still goes once they land, after the person has moved to another channel', async () => {
    const uploads = held();
    const { view, box, sent, user, rerender, storage } = await mount({
      api: aSignedInApi(uploads.api),
    });
    paste(box(), [new File([new Uint8Array([1])], 'a.txt')]);
    await user.type(box(), 'look{Enter}');
    rerender({ channelId: IDS.deploys, channelName: 'deploys' });
    expect(sent()).toEqual([]);
    // Not this channel's: neither its file nor its waiting is drawn here.
    expect(view.queryByText('a.txt')).toBeNull();
    expect(view.queryByText('Sends when the files finish uploading.')).toBeNull();
    uploads.finish(0);
    await settle();
    expect(sent()).toEqual([
      { channelId: IDS.api, content: 'look', attachmentIds: [uploads.calls[0]?.id] },
    ]);
    // What was sent is gone from where it was written.
    expect(storage?.getItem(mine(IDS.api))).toBeNull();
    rerender({ channelId: IDS.api, channelName: 'api' });
    expect(box().value).toBe('');
    expect(view.queryByText('a.txt')).toBeNull();
    expect(view.queryByText('Sends when the files finish uploading.')).toBeNull();
    expect(sent()).toHaveLength(1);
  });

  test('a waiting send whose file fails while the person is away is not sent, is said, and is all there on coming back', async () => {
    const uploads = held();
    const { view, box, sent, user, rerender } = await mount({ api: aSignedInApi(uploads.api) });
    paste(box(), [new File([new Uint8Array([1])], 'a.txt')]);
    await user.type(box(), 'look{Enter}');
    rerender({ channelId: IDS.deploys, channelName: 'deploys' });
    uploads.refuse(0, new ApiError(503, 'STORAGE_UNAVAILABLE', 'down'));
    await settle();
    expect(sent()).toEqual([]);
    expect(
      view.getByText('Not sent to api: a file did not upload. The message is still there.'),
    ).toBeDefined();
    rerender({ channelId: IDS.api, channelName: 'api' });
    expect(box().value).toBe('look');
    expect(view.getByText('File storage is unavailable')).toBeDefined();
    expect(view.getByRole('button', { name: 'Retry a.txt' })).toBeDefined();
    expect(view.queryByText('Sends when the files finish uploading.')).toBeNull();
  });

  test('files attached and not sent are still there after a channel switch, and go with the message', async () => {
    const uploads = held();
    const { view, box, sent, user, rerender } = await mount({ api: aSignedInApi(uploads.api) });
    paste(box(), [new File([new Uint8Array([1])], 'a.txt')]);
    rerender({ channelId: IDS.deploys, channelName: 'deploys' });
    expect(view.queryByText('a.txt')).toBeNull();
    uploads.finish(0);
    await settle();
    rerender({ channelId: IDS.api, channelName: 'api' });
    expect(view.getByText('a.txt')).toBeDefined();
    await user.type(box(), 'here{Enter}');
    expect(sent()).toEqual([
      { channelId: IDS.api, content: 'here', attachmentIds: [uploads.calls[0]?.id] },
    ]);
  });

  test('coming back while it still uploads finds the send waiting, and it goes once, from here', async () => {
    const uploads = held();
    const { view, box, sent, user, rerender } = await mount({ api: aSignedInApi(uploads.api) });
    paste(box(), [new File([new Uint8Array([1])], 'a.txt')]);
    await user.type(box(), 'look{Enter}');
    rerender({ channelId: IDS.deploys, channelName: 'deploys' });
    rerender({ channelId: IDS.api, channelName: 'api' });
    expect(box().value).toBe('look');
    expect(view.getByText('Sends when the files finish uploading.')).toBeDefined();
    uploads.finish(0);
    await settle();
    expect(sent()).toEqual([
      { channelId: IDS.api, content: 'look', attachmentIds: [uploads.calls[0]?.id] },
    ]);
    expect(box().value).toBe('');
  });

  test("a reply waiting on its files still goes once they land, after the thread's panel is closed", async () => {
    const uploads = held();
    const root = aMessage(1).id;
    const { box, sent, user, shown } = await mount({
      api: aSignedInApi(uploads.api),
      props: { parentId: root },
    });
    paste(box(), [new File([new Uint8Array([1])], 'a.txt')]);
    await user.type(box(), 'see{Enter}');
    shown(false);
    uploads.finish(0);
    await settle();
    expect(sent()).toEqual([
      {
        channelId: IDS.api,
        content: 'see',
        parentId: root,
        attachmentIds: [uploads.calls[0]?.id],
      },
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
      'file storage down',
      new ApiError(503, 'STORAGE_UNAVAILABLE', 'down'),
      { en: 'File storage is unavailable', tr: 'Dosya deposuna ulaşılamıyor', retry: true },
    ],
    [
      'no longer in the workspace',
      new ApiError(404, 'WORKSPACE_NOT_FOUND', 'gone'),
      {
        en: 'You no longer have access to this workspace',
        tr: 'Bu çalışma alanına artık erişimin yok',
        retry: false,
      },
    ],
    [
      'a refusal no upload meets',
      new ApiError(500, 'INTERNAL', 'oops'),
      { en: 'Didn’t upload', tr: 'Yüklenmedi', retry: true },
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
    const chip = view.getByText('Larger than 25 MB').closest('li');
    if (chip === null) throw new Error('no chip');
    // Nothing to retry: the same bytes are as large again. Remove is the way on.
    expect(within(chip).queryByRole('button', { name: 'Retry huge.mov' })).toBeNull();
    expect(within(chip).getByRole('button', { name: 'Remove huge.mov' })).toBeDefined();
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

  test('typing in a reply box says nothing to the channel: nothing will arrive in its feed', async () => {
    const { view, box, user } = await mount({ props: { parentId: aMessage(1).id } });
    await user.type(box(), 'hello');
    expect(view.world.sockets.sent('TYPING')).toEqual([]);
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

describe('the preview (D-181)', () => {
  test('shows the draft as the message will be drawn, and goes back to the text untouched', async () => {
    const { view, box, user } = await mount();
    await user.click(box());
    await user.keyboard('ship **it** now');
    const toggle = view.getByRole('button', { name: 'Preview' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await user.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    // Drawn instead of the text, not beside it; the text is kept under it.
    expect(view.container.querySelector('textarea')?.hidden).toBe(true);
    const drawn = view.container.querySelector('[data-composer-preview] strong');
    expect(drawn?.textContent).toBe('it');
    await user.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(view.container.querySelector('[data-composer-preview]')).toBeNull();
    expect(box().hidden).toBe(false);
    expect(box().value).toBe('ship **it** now');
    expectFocusOn(box());
  });

  test('Mod+Shift+P does the same from the box, and an empty draft says there is nothing to preview', async () => {
    const { view, box, user } = await mount();
    await user.click(box());
    await user.keyboard('{Control>}{Shift>}p{/Shift}{/Control}');
    expect(view.container.querySelector('[data-composer-preview]')).not.toBeNull();
    expect(view.getByText('Nothing to preview yet')).toBeDefined();
    await user.click(view.getByRole('button', { name: 'Preview' }));
    await user.keyboard('hi');
    await user.keyboard('{Control>}{Shift>}p{/Shift}{/Control}');
    expect(view.container.querySelector('[data-composer-preview]')?.textContent).toBe('hi');
  });

  test('a preview that is open does not stop the send', async () => {
    const { view, box, user, sent } = await mount();
    await user.click(box());
    await user.keyboard('ready');
    await user.click(view.getByRole('button', { name: 'Preview' }));
    await user.click(view.getByRole('button', { name: 'Send' }));
    expect(sent().map((frame) => frame.content)).toEqual(['ready']);
  });
});
