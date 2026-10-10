/**
 * The composer as a person uses it: typing, the keys, a paste, a draft left behind and
 * found again — against the real provider tree, a socket the test drives and storage and
 * time it holds.
 */
import { describe, expect, test } from 'bun:test';
import { act, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { MESSAGE_CONTENT_MAX } from '@purlay/types';
import { SessionGate } from '../session/session';
import { WorkspaceScopeProvider } from '../shell/workspace';
import { RealtimeProvider } from '../../realtime/realtime-provider';
import { Toaster } from '../../ui/toast';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom } from '../../testing/dom';
import { fakeSchedule } from '../../testing/fakes';
import { IDS, aMessage, aSignedInApi } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import type { Api } from '../../data/api';
import { Composer, DRAFT_DEBOUNCE_MS, type ComposerProps } from './composer';
import { ComposerPortsContext } from './composer-ports';
import type { DraftStorage } from './drafts';

installDom();

const memory = (): DraftStorage & { readonly items: Map<string, string> } => {
  const items = new Map<string, string>();
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
  readonly sent: () => { channelId: unknown; content: unknown; parentId?: unknown }[];
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
  const sent = (): { channelId: unknown; content: unknown; parentId?: unknown }[] =>
    view.world.sockets
      .sent('MESSAGE_SEND')
      .map((f) => f.payload as { channelId: unknown; content: unknown; parentId?: unknown });
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
  storage.setItem(`purlay.draft.${channelId}`, text);
  return storage;
};

const press = async (user: ReturnType<typeof person>, keys: string): Promise<void> => {
  await user.keyboard(keys);
};

describe('what it shows', () => {
  test('is a labelled textarea for the channel, in one card with a send button, and no prompt prefix', async () => {
    const { view, box } = await mount();
    expect(view.getByRole('textbox', { name: 'Message api' })).toBe(box());
    expect(box().getAttribute('placeholder')).toBe(
      'Write to api. Enter sends, Shift+Enter adds a line.',
    );
    expect(view.queryByText('api ›')).toBeNull();
    const card = view.container.querySelector('[data-composer-card]');
    expect(card?.className).toContain('rounded-lg');
    expect(card?.contains(box())).toBe(true);
    const send = view.getByRole('button', { name: 'Send' });
    expect(card?.contains(send)).toBe(true);
    expect(send.className).toContain('rounded-pill');
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
    expect(view.getByRole('textbox', { name: 'api kanalına mesaj' })).toBeDefined();
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
    expect(document.activeElement === box()).toBe(true);
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('the Send button sends too', async () => {
    const { view, box, sent, user } = await mount();
    await user.type(box(), 'by button');
    await user.click(view.getByRole('button', { name: /Send/ }));
    expect(sent()).toEqual([{ channelId: IDS.api, content: 'by button' }]);
    expect(document.activeElement === box()).toBe(true);
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
    expect(document.activeElement === box()).toBe(true);
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
    expect(document.activeElement === box()).toBe(true);
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

  test('a paste with no clipboard data, or only an image, is left to the browser', async () => {
    const { box } = await mount();
    expect(fireEvent.paste(box())).toBe(true);
    const image = {
      getData: (): string => '',
      files: [{ type: 'image/png' }],
      items: [{ kind: 'file', type: 'image/png' }],
    };
    expect(fireEvent.paste(box(), { clipboardData: image })).toBe(true);
    expect(box().value).toBe('');
  });
});

describe('drafts', () => {
  test('are written a moment after typing stops, and not before', async () => {
    const { box, storage, timers, user } = await mount();
    await user.type(box(), 'half');
    expect(storage?.getItem(`purlay.draft.${IDS.api}`)).toBeNull();
    act(() => {
      timers.advance(DRAFT_DEBOUNCE_MS - 1);
    });
    expect(storage?.getItem(`purlay.draft.${IDS.api}`)).toBeNull();
    act(() => {
      timers.advance(1);
    });
    expect(storage?.getItem(`purlay.draft.${IDS.api}`)).toBe('half');
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
    expect(storage.getItem(`purlay.draft.${IDS.api}`)).toBe('for api');
    await user.type(box(), 'for deploys');
    rerender({ channelId: IDS.api, channelName: 'api' });
    expect(box().value).toBe('for api');
    expect(storage.getItem(`purlay.draft.${IDS.deploys}`)).toBe('for deploys');
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
    expect(storage.getItem(`purlay.draft.${IDS.api}.${root}`)).toBe('thread text');
  });

  test('are gone the moment they are sent, so a reload does not bring them back', async () => {
    const storage = memory();
    const { box, timers, user } = await mount({ storage });
    await user.type(box(), 'sent soon');
    act(() => {
      timers.advance(DRAFT_DEBOUNCE_MS);
    });
    expect(storage.items.size).toBe(1);
    await press(user, '{Enter}');
    expect(storage.items.size).toBe(0);
    act(() => {
      timers.advance(DRAFT_DEBOUNCE_MS);
    });
    expect(storage.items.size).toBe(0);
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
    expect(document.activeElement === box()).toBe(true);
    await press(user, '{Escape}');
    rerender({ channelId: IDS.deploys, channelName: 'deploys' });
    expect(document.activeElement === box()).toBe(true);
  });

  test("a thread's box does not take focus when it appears", async () => {
    const { box } = await mount();
    expect(document.activeElement === box()).toBe(false);
  });
});
