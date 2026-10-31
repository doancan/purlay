/**
 * Drafts and sent (D-215) as a person meets it: the drafts this device kept for them, where each
 * opens, deleting with Undo, and what they sent — asked of search, narrowed to them.
 */
import { describe, expect, test } from 'bun:test';
import { act, within } from '@testing-library/react';
import type { SearchPage } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import type { Api } from '../../data/api';
import { installDom } from '../../testing/dom';
import { memoryStorage } from '../../testing/fakes';
import { IDS, ME, aMessage, aSignedInApi } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { settle } from '../../testing/channel-harness';
import { person } from '../../testing/user';
import { Toaster } from '../../ui/toast';
import { ComposerPortsContext } from '../composer/composer-ports';
import { draftKey } from '../composer/drafts';

installDom();

const visit = async (
  drafts: Readonly<Record<string, string>>,
  api: Partial<Api> = {},
): Promise<
  Awaited<ReturnType<typeof renderApp>> & { storage: ReturnType<typeof memoryStorage> }
> => {
  const storage = memoryStorage(drafts);
  const view = await renderApp(
    <ComposerPortsContext.Provider
      value={{ storage, schedule: () => (): void => undefined, touchOnly: () => false }}
    >
      <Outlet />
      <Toaster dismissLabel="Close" />
    </ComposerPortsContext.Provider>,
    { path: '/w/acme/drafts', api: aSignedInApi(api) },
  );
  await settle();
  return Object.assign(view, { storage });
};

describe('drafts', () => {
  test('lists each draft with where it is, and a draft in a channel no longer seen is left out', async () => {
    const view = await visit({
      [draftKey(ME.id, IDS.api, undefined)]: 'Pool size to 20?',
      [draftKey(ME.id, IDS.deploys, 'root1')]: 'Yes, after the window.',
      [draftKey(ME.id, 'gone-channel', undefined)]: 'lost',
    });
    expect(view.getByRole('heading', { level: 1, name: 'Drafts and sent' })).toBeDefined();
    expect(view.getByText('Pool size to 20?')).toBeDefined();
    expect(view.getByText('Yes, after the window.')).toBeDefined();
    expect(view.getByText('· in a thread')).toBeDefined();
    expect(view.queryByText('lost')).toBeNull();
  });

  test('opening one goes to its composer: the channel, or the thread', async () => {
    const view = await visit({ [draftKey(ME.id, IDS.deploys, 'root1')]: 'Yes, after the window.' });
    await person().click(view.getByRole('button', { name: /Yes, after the window\./ }));
    expect(view.world.history.stack.at(-1)).toBe(`/w/acme/c/${IDS.deploys}?thread=root1`);
  });

  test('deleting one takes it from storage, and Undo puts it back', async () => {
    const key = draftKey(ME.id, IDS.api, undefined);
    const view = await visit({ [key]: 'Pool size to 20?' });
    await person().click(view.getByRole('button', { name: 'Delete draft' }));
    expect(view.storage.getItem(key)).toBeNull();
    expect(view.queryByText('Pool size to 20?')).toBeNull();
    await person().click(view.getByRole('button', { name: 'Undo' }));
    expect(view.storage.getItem(key)).toBe('Pool size to 20?');
    expect(view.getByText('Pool size to 20?')).toBeDefined();
  });

  test('none says so', async () => {
    const view = await visit({});
    expect(view.getByText('No drafts')).toBeDefined();
  });

  test('a draft written in another tab shows up here', async () => {
    const view = await visit({});
    view.storage.setItem(draftKey(ME.id, IDS.api, undefined), 'Written elsewhere');
    await act(async () => {
      window.dispatchEvent(new Event('storage'));
      await Promise.resolve();
    });
    expect(view.getByText('Written elsewhere')).toBeDefined();
    expect(view.queryByText('No drafts')).toBeNull();
  });
});

describe('sent', () => {
  test('is search narrowed to the person, with no words, and opens the message', async () => {
    const asked: unknown[] = [];
    const page: SearchPage = {
      data: [aMessage(3, { sender: ME, content: 'shipped it' })],
      nextCursor: null,
    };
    const view = await visit(
      {},
      {
        search: (_workspace, query) => {
          asked.push(query);
          return Promise.resolve(page);
        },
      },
    );
    const tabs = within(view.getByRole('group', { name: 'Show' }));
    await person().click(tabs.getByRole('button', { name: 'Sent' }));
    await settle();
    expect(asked).toEqual([{ q: '', senderId: ME.id, before: undefined }]);
    await person().click(view.getByRole('button', { name: /shipped it/ }));
    expect(view.world.history.stack.at(-1)).toBe(`/w/acme/c/${IDS.api}?message=${aMessage(3).id}`);
  });

  const openSent = async (api: Partial<Api>): Promise<Awaited<ReturnType<typeof visit>>> => {
    const view = await visit({}, api);
    const tabs = within(view.getByRole('group', { name: 'Show' }));
    await person().click(tabs.getByRole('button', { name: 'Sent' }));
    await settle();
    return view;
  };

  test('a reply opens in its thread', async () => {
    const reply = aMessage(4, { sender: ME, content: 'on it', parentId: 'root1' });
    const view = await openSent({
      search: () => Promise.resolve({ data: [reply], nextCursor: null }),
    });
    expect(view.getByText('· in a thread')).toBeDefined();
    await person().click(view.getByRole('button', { name: /on it/ }));
    expect(view.world.history.stack.at(-1)).toBe(`/w/acme/c/${IDS.api}?thread=root1`);
  });

  test('nothing sent says so', async () => {
    const view = await openSent({
      search: () => Promise.resolve({ data: [], nextCursor: null }),
    });
    expect(view.getByText('Nothing sent yet')).toBeDefined();
  });

  test('a failure to load says so, and Retry asks again', async () => {
    let answers = 0;
    const view = await openSent({
      search: () => {
        answers += 1;
        return answers === 1
          ? Promise.reject(new Error('offline'))
          : Promise.resolve({
              data: [aMessage(3, { sender: ME, content: 'shipped it' })],
              nextCursor: null,
            });
      },
    });
    expect(view.getByText('Couldn’t load what you sent')).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(view.getByText('shipped it')).toBeDefined();
  });

  test('Load more asks for the page before the last, and adds it below', async () => {
    const asked: unknown[] = [];
    const view = await openSent({
      search: (_workspace, query) => {
        asked.push(query.before);
        return Promise.resolve(
          query.before === undefined
            ? { data: [aMessage(5, { sender: ME, content: 'newest' })], nextCursor: 'cursor-1' }
            : { data: [aMessage(2, { sender: ME, content: 'older' })], nextCursor: null },
        );
      },
    });
    expect(view.queryByText('older')).toBeNull();
    await person().click(view.getByRole('button', { name: 'Load more' }));
    await settle();
    expect(asked).toEqual([undefined, 'cursor-1']);
    expect(view.getByText('newest')).toBeDefined();
    expect(view.getByText('older')).toBeDefined();
    expect(view.queryByRole('button', { name: 'Load more' })).toBeNull();
  });
});
