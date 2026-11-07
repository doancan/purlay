/** Real card rendering, viewport gating, quiet failures and edits while metadata is pending. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { act, fireEvent, waitFor } from '@testing-library/react';
import type { Api } from '../../data/api';
import { keys } from '../../data/keys';
import { expectNoAxeViolations } from '../../testing/axe';
import { installDom, settleScheduler } from '../../testing/dom';
import { IDS, aMessage, aSignedInApi } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { WebLinkCards } from './web-link-cards';
import { systemClock } from '../../system-clock';
import { expectFocusOn } from '../../testing/focus';

installDom();
const URL = 'https://docs.example/report#handover';
const CARD = {
  title: 'Vardiya planı <script>alert(1)</script>',
  description: 'Üretim ve sevkiyat için güncel plan',
  imageUrl: null,
};
const props = { channelId: IDS.api, messageId: aMessage(1).id };
const observed = new Map<Element, IntersectionObserverCallback>();
let original: typeof IntersectionObserver;
beforeEach(() => {
  original = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class {
    private readonly callback: IntersectionObserverCallback;
    public constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
    }
    public observe(target: Element): void {
      observed.set(target, this.callback);
    }
    public disconnect(): void {
      for (const [target, callback] of observed)
        if (callback === this.callback) observed.delete(target);
    }
  } as unknown as typeof IntersectionObserver;
});
afterEach(() => {
  globalThis.IntersectionObserver = original;
  observed.clear();
});
const visible = async (value = true): Promise<void> => {
  await act(async () => {
    for (const [target, callback] of observed)
      callback(
        [{ target, isIntersecting: value } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    await Promise.resolve();
  });
};
const show = async (
  previewMessageLink: Api['previewMessageLink'],
  content = URL,
  locale: 'en' | 'tr' = 'en',
): ReturnType<typeof renderApp> => {
  const view = await renderApp(<WebLinkCards {...props} content={content} />, {
    api: aSignedInApi({ previewMessageLink }),
    locale,
  });
  if (/https/i.test(content))
    await waitFor(() => {
      expect(observed.size).toBeGreaterThan(0);
    });
  return view;
};

test('waits for the viewport, then uses plain text, the original destination and no origin image', async () => {
  const calls: string[] = [];
  const view = await show((id, url) => {
    calls.push(`${id}:${url}`);
    return Promise.resolve(CARD);
  });
  expect(calls).toEqual([]);
  expect(view.container.querySelector('[data-web-link-card]')).toBeNull();
  await visible();
  await waitFor(() => {
    expect(view.container.querySelector('[data-web-link-card]')).not.toBeNull();
  });
  expect(calls).toEqual([`${props.messageId}:${URL}`]);
  const link = view.getByRole('link');
  expect(link.getAttribute('href')).toBe(URL);
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  expect(link.textContent).toContain('docs.example');
  expect(link.textContent).toContain(CARD.title);
  expect(link.textContent).toContain(CARD.description);
  expect(link.textContent).toContain('Opens in a new tab');
  expect(link.querySelector('script')).toBeNull();
  expect(link.querySelector('img')).toBeNull();
  await expectNoAxeViolations(view.container);
  link.focus();
  expectFocusOn(link);
});

test('leaving the viewport retains card height and disables stale background reads', async () => {
  let calls = 0;
  const view = await show(() => {
    calls += 1;
    return Promise.resolve(CARD);
  });
  await visible();
  await waitFor(() => {
    expect(view.container.querySelector('[data-web-link-card]')).not.toBeNull();
  });
  await visible(false);
  await act(async () => {
    await view.world.client.invalidateQueries({ queryKey: keys.webLinkPreviews(IDS.api) });
  });
  expect(view.container.querySelector('[data-web-link-card]')).not.toBeNull();
  expect(calls).toBe(1);
  await visible();
  await waitFor(() => {
    expect(calls).toBe(2);
  });
});

test('plain messages add no preview observer, query or suspended content', async () => {
  let calls = 0;
  const view = await show(() => {
    calls += 1;
    return Promise.resolve(CARD);
  }, 'The next shift plan will be shared here.');
  expect(observed.size).toBe(0);
  expect(view.container.querySelector('[data-web-link-cards]')).toBeNull();
  expect(calls).toBe(0);
});

test('code and existing special links never make generic metadata requests', async () => {
  let calls = 0;
  const view = await show(() => {
    calls += 1;
    return Promise.resolve(CARD);
  }, '`https://docs.example/report`\nhttps://github.com/org/repo/pull/1\nhttps://pictures.example/a.png');
  await visible();
  await act(async () => {
    await settleScheduler();
  });
  expect(view.container.querySelector('[data-web-link-card]') === null).toBe(true);
  expect(calls).toBe(0);
});

test.each([
  { kind: 'card', age: 61_000, calls: 0 },
  { kind: 'card', age: 301_000, calls: 1 },
  { kind: 'none', age: 59_000, calls: 0 },
  { kind: 'none', age: 61_000, calls: 1 },
])(
  '$kind metadata aged $age ms is refreshed only after its own freshness window',
  async (scenario) => {
    let calls = 0;
    const view = await show(() => {
      calls += 1;
      return Promise.resolve(CARD);
    });
    const key = keys.webLinkPreview(IDS.api, props.messageId, URL);
    view.world.client.setQueryData(key, scenario.kind === 'card' ? CARD : null, {
      updatedAt: systemClock.now().getTime() - scenario.age,
    });
    await visible();
    await waitFor(() => {
      expect(view.world.client.getQueryCache().find({ queryKey: key })?.getObserversCount()).toBe(
        1,
      );
    });
    await waitFor(() => {
      expect(view.world.client.getQueryState(key)?.fetchStatus).toBe('idle');
    });
    expect(calls).toBe(scenario.calls);
  },
);

test.each(['none', 'error'] as const)(
  'a %s answer draws no error card and does not retry',
  async (kind) => {
    let calls = 0;
    const view = await show(() => {
      calls += 1;
      return kind === 'none' ? Promise.resolve(null) : Promise.reject(new Error('Unavailable'));
    });
    await visible();
    await waitFor(() => {
      expect(
        view.world.client.getQueryState(keys.webLinkPreview(IDS.api, props.messageId, URL))
          ?.fetchStatus,
      ).toBe('idle');
    });
    expect(view.container.querySelector('[data-web-link-card]')).toBeNull();
    expect(view.queryByRole('alert')).toBeNull();
    expect(calls).toBe(1);
  },
);

test('a late answer cannot restore a link edited out of the current message', async () => {
  const waiting = Promise.withResolvers<typeof CARD>();
  const view = await show(() => waiting.promise);
  await visible();
  await waitFor(() => {
    expect(
      view.world.client.getQueryState(keys.webLinkPreview(IDS.api, props.messageId, URL))
        ?.fetchStatus,
    ).toBe('fetching');
  });
  view.rerender(<WebLinkCards {...props} content="The report was withdrawn" />);
  await act(async () => {
    waiting.resolve(CARD);
    await waiting.promise;
  });
  expect(view.container.querySelector('[data-web-link-cards]')).toBeNull();
});

test('images go through the proxy, failures disappear, and a replaced image gets a fresh attempt', async () => {
  const image = 'https://images.example/cover.jpg?token=one';
  const view = await show(() => Promise.resolve({ ...CARD, imageUrl: image }), URL, 'tr');
  await visible();
  await waitFor(() => {
    expect(view.container.querySelector('img')).not.toBeNull();
  });
  const cover = view.container.querySelector('img');
  expect(cover?.getAttribute('src')).toBe(`/api/images?url=${encodeURIComponent(image)}`);
  expect(cover?.getAttribute('alt')).toBe('');
  expect(view.getByRole('link').textContent).toContain('Yeni sekmede açılır');
  expect(view.getByRole('link').getAttribute('href')).toBe(URL);
  if (cover === null) throw new Error('Missing cover');
  fireEvent.error(cover);
  expect(view.container.querySelector('img')).toBeNull();
  await act(async () => {
    view.world.client.setQueryData(keys.webLinkPreview(IDS.api, props.messageId, URL), {
      ...CARD,
      imageUrl: 'https://images.example/new.jpg',
    });
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(view.container.querySelector('img')?.getAttribute('src')).toContain(
      encodeURIComponent('https://images.example/new.jpg'),
    );
  });
});
