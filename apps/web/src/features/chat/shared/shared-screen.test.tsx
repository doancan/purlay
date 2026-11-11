/** Shared is a chat catalogue: filters survive navigation and every item opens its source. */
import { afterEach, describe, expect, test } from 'bun:test';
import { act, fireEvent, waitFor } from '@testing-library/react';
import { onlineManager } from '@tanstack/react-query';
import type { SharedLinkItem, SharedFilters } from '@purlay/types';
import { Outlet } from '../../../app/outlet';
import type { Api } from '../../../data/api';
import { ApiError } from '../../../data/errors';
import { keys } from '../../../data/keys';
import { channelAccessRevoked } from '../../../data/access-change';
import { messageHidden, messageRevised } from '../../../data/cache';
import { expectNoAxeViolations } from '../../../testing/axe';
import { settle } from '../../../testing/channel-harness';
import { installDom } from '../../../testing/dom';
import {
  ALICE,
  BOB,
  IDS,
  WHEN,
  aChannel,
  aSignedInApi,
  messageIdAt,
} from '../../../testing/fixtures';
import { renderApp } from '../../../testing/render';
import { person } from '../../../testing/user';

installDom();
const mounted = new Set<Awaited<ReturnType<typeof renderApp>>>();
afterEach(() => {
  for (const view of mounted) {
    view.unmount();
    view.world.client.clear();
  }
  mounted.clear();
  onlineManager.setOnline(true);
});
const link: SharedLinkItem = {
  kind: 'link',
  key: 'a'.repeat(64),
  link: { url: 'http://intranet/policy', label: 'Leave policy' },
  messageId: messageIdAt(4),
  parentId: messageIdAt(2),
  channelId: IDS.api,
  sender: BOB,
  sourceName: null,
  sentAt: WHEN,
};
const visit = async (
  api: Partial<Api>,
  path = '/w/acme/shared?view=links',
): ReturnType<typeof renderApp> => {
  const view = await renderApp(<Outlet />, { path, api: aSignedInApi(api) });
  mounted.add(view);
  await settle();
  await waitFor(() => {
    expect(view.getByRole('heading', { name: 'Shared', level: 1 })).toBeDefined();
  });
  await settle();
  return view;
};

describe('Shared workspace catalogue', () => {
  test('a group conversation is named by its people in the channel filter', async () => {
    const view = await visit({
      channels: () =>
        Promise.resolve([
          aChannel(IDS.dm, null, { type: 'direct_message', peer: null, peers: [ALICE, BOB] }),
        ]),
      shared: () => Promise.resolve({ data: [], nextCursor: null, indexing: false }),
    });
    await person().click(view.getByText('Advanced filters'));
    expect(view.getByRole('option', { name: 'Alice, Bob' })).toBeDefined();
    view.unmount();
  });
  test('a rendered link opens safely and its source opens the exact thread reply', async () => {
    const view = await visit({
      shared: () => Promise.resolve({ data: [link], nextCursor: null, indexing: false }),
    });
    await waitFor(() => {
      expect(view.getByRole('heading', { name: 'Shared', level: 1 })).toBeDefined();
    });
    await waitFor(() => {
      expect(view.getByRole('link', { name: 'Leave policy' }).getAttribute('href')).toBe(
        link.link.url,
      );
    });
    expect(view.getByRole('link', { name: 'Go to message' }).getAttribute('href')).toBe(
      `/w/acme/c/${IDS.api}?message=${link.messageId}`,
    );
    await expectNoAxeViolations(view.container);
    await person().click(view.getByRole('link', { name: 'Go to message' }));
    expect(view.world.history.stack.at(-1)).toBe(`/w/acme/c/${IDS.api}?message=${link.messageId}`);
    view.unmount();
  });

  test('search submits once, preserves the tab in the address and clears incompatible file type', async () => {
    const asked: SharedFilters[] = [];
    const view = await visit(
      {
        shared: (_workspace, query) => {
          asked.push(query);
          return Promise.resolve({ data: [], nextCursor: null, indexing: false });
        },
      },
      '/w/acme/shared?view=files&type=pdf',
    );
    await person().type(view.getByLabelText('Search shared items'), 'Policy');
    expect(asked).toHaveLength(1);
    await person().keyboard('{Enter}');
    await settle();
    expect(asked.at(-1)).toMatchObject({ view: 'files', type: 'pdf', q: 'Policy' });
    await person().click(view.getByRole('button', { name: /^Links$/ }));
    await settle();
    expect(asked.at(-1)).toMatchObject({ view: 'links', q: 'Policy' });
    expect(asked.at(-1)?.type).toBeUndefined();
    expect(view.world.history.stack.at(-1)).toBe('/w/acme/shared?view=links&q=Policy');
    expect(view.getByRole('heading', { name: 'No matching items' })).toBeDefined();
    view.unmount();
  });

  test('pagination keeps unique source items and a failed refresh keeps the last list with Retry', async () => {
    const next = {
      ...link,
      key: 'b'.repeat(64),
      sender: null,
      sourceName: 'ERP',
      link: { url: 'https://example.com/order', label: 'Purchase order' },
    };
    let fail = false;
    const view = await visit({
      shared: (_workspace, query) =>
        fail
          ? Promise.reject(new ApiError(0, 'NETWORK', 'offline'))
          : Promise.resolve(
              query.before === undefined
                ? { data: [link], nextCursor: 'opaque', indexing: true }
                : { data: [link, next], nextCursor: null, indexing: false },
            ),
    });
    expect(
      view.getByText('Shared links are being updated. Older links may still be added.'),
    ).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Load more' }));
    await settle();
    expect(view.getAllByRole('link', { name: 'Leave policy' })).toHaveLength(1);
    expect(view.getByRole('link', { name: 'Purchase order' })).toBeDefined();
    expect(view.getByText('ERP')).toBeDefined();
    fail = true;
    await act(async () => {
      await view.world.client.invalidateQueries({ queryKey: keys.shared(IDS.workspace) });
    });
    await settle();
    expect(
      view.getByText('The list could not be refreshed. These are the last loaded items.'),
    ).toBeDefined();
    expect(view.getByRole('link', { name: 'Leave policy' })).toBeDefined();
    fail = false;
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(
      view.queryByText('The list could not be refreshed. These are the last loaded items.'),
    ).toBeNull();
    view.unmount();
  });

  test('failed initial reads retry and malformed filters recover without making an invalid request', async () => {
    let reads = 0;
    const view = await visit({
      shared: () =>
        ++reads === 1
          ? Promise.reject(new ApiError(0, 'NETWORK', 'offline'))
          : Promise.resolve({ data: [], nextCursor: null, indexing: false }),
    });
    expect(view.getByRole('heading', { name: 'Shared items could not be loaded' })).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Retry' }));
    await settle();
    expect(view.getByRole('heading', { name: 'No shared links yet' })).toBeDefined();
    view.unmount();
    const invalid = await visit(
      {
        shared: () => {
          reads++;
          return Promise.resolve({ data: [], nextCursor: null, indexing: false });
        },
      },
      '/w/acme/shared?since=2026-99-99T00:00:00Z',
    );
    expect(invalid.getByRole('heading', { name: 'These filters could not be used' })).toBeDefined();
    expect(reads).toBe(2);
    await person().click(
      invalid.getAllByRole('button', { name: 'Clear filters' }).at(-1) ?? invalid.container,
    );
    await settle();
    expect(invalid.getByRole('heading', { name: 'No shared files yet' })).toBeDefined();
    expect(reads).toBe(3);
    invalid.unmount();
  });

  test('a cold offline read shows a recovery action and resumes when the browser reconnects', async () => {
    let held = true;
    const view = await visit({
      shared: () =>
        held
          ? new Promise(() => undefined)
          : Promise.resolve({ data: [link], nextCursor: null, indexing: false }),
    });
    try {
      await act(async () => {
        await view.world.client.cancelQueries({ queryKey: keys.shared(IDS.workspace) });
        onlineManager.setOnline(false);
        void view.world.client.refetchQueries({ queryKey: keys.shared(IDS.workspace) });
      });
      await settle();
      expect(view.getByRole('heading', { name: /You are offline/ })).toBeDefined();
      await person().click(view.getByRole('button', { name: 'Retry' }));
      held = false;
      await act(() => {
        onlineManager.setOnline(true);
        return Promise.resolve();
      });
      await settle();
      expect(view.getByRole('link', { name: 'Leave policy' })).toBeDefined();
    } finally {
      view.unmount();
      onlineManager.setOnline(true);
    }
  });

  test('channel and person filters submit current choices, file kind can be cleared, and Reset restores the catalogue', async () => {
    const asked: SharedFilters[] = [];
    const view = await visit(
      {
        shared: (_workspace, query) => {
          asked.push(query);
          return Promise.resolve({ data: [], nextCursor: null, indexing: false });
        },
      },
      '/w/acme/shared?view=files&type=pdf',
    );
    await person().selectOptions(view.getByLabelText('Where'), IDS.api);
    await settle();
    expect(asked.at(-1)?.channelId).toBe(IDS.api);
    await person().selectOptions(view.getByLabelText('File type'), 'image');
    await settle();
    expect(asked.at(-1)?.type).toBe('image');
    await person().selectOptions(view.getByLabelText('File type'), '');
    await settle();
    expect(asked.at(-1)?.type).toBeUndefined();
    await person().click(view.getByRole('button', { name: /From Anyone/ }));
    await person().click(view.getByRole('menuitemradio', { name: /Bob/ }));
    await settle();
    expect(asked.at(-1)?.senderId).toBe(IDS.bob);
    await person().click(view.getByRole('button', { name: /From date Pick a day/ }));
    await person().click(view.getByRole('button', { name: 'Today' }));
    await settle();
    expect(asked.at(-1)?.since).toBeDefined();
    await person().click(view.getByRole('button', { name: /Before date Pick a day/ }));
    await person().click(view.getByRole('button', { name: 'Today' }));
    await settle();
    expect(asked.at(-1)?.until).toBeDefined();
    await person().click(view.getByRole('button', { name: 'Clear filters' }));
    await settle();
    expect(asked.at(-1)).toMatchObject({ view: 'files' });
    expect(asked.at(-1)?.senderId).toBeUndefined();
    view.unmount();
  });

  test.each(['hide', 'delete'] as const)(
    'files keep authenticated controls and a source %s retires the open media snapshot while another item remains',
    async (removal) => {
      const image = {
        ...link,
        kind: 'file' as const,
        attachment: {
          id: messageIdAt(7),
          fileName: 'Floor plan.png',
          mimeType: 'image/png',
          sizeBytes: 20,
          kind: 'image' as const,
          width: 120,
          height: 80,
        },
      };
      const file = {
        ...image,
        messageId: messageIdAt(6),
        attachment: {
          ...image.attachment,
          id: messageIdAt(8),
          kind: 'file' as const,
          fileName: 'Policy.txt',
          mimeType: 'text/plain',
          width: null,
          height: null,
        },
      };
      let removed = false;
      const view = await visit(
        {
          shared: () =>
            Promise.resolve({
              data: removed ? [file] : [image, file],
              nextCursor: null,
              indexing: false,
            }),
        },
        '/w/acme/shared?view=files',
      );
      expect(view.getByRole('link', { name: /Download Policy.txt/ }).getAttribute('href')).toBe(
        `/api/attachments/${file.attachment.id}`,
      );
      expect(view.getByRole('button', { name: 'Preview Policy.txt' })).toBeDefined();
      const thumbnail = view.container.querySelector(
        `img[src="/api/attachments/${image.attachment.id}/thumbnail"]`,
      );
      if (thumbnail === null) throw new Error('no thumbnail');
      fireEvent.error(thumbnail);
      const open = view.getByRole('link', { name: 'Open Floor plan.png' });
      fireEvent.pointerEnter(open);
      fireEvent.focus(open);
      await person().click(open);
      await waitFor(() => {
        expect(view.getByRole('dialog')).toBeDefined();
      });
      act(() => {
        removed = true;
        if (removal === 'hide') messageHidden(view.world.client, image.messageId, WHEN, IDS.api);
        else
          messageRevised(view.world.client, {
            messageId: image.messageId,
            channelId: IDS.api,
            parentId: null,
            content: '',
            editedAt: null,
            deletedAt: WHEN,
            mentions: [],
          });
      });
      await settle();
      expect(document.querySelector('[data-image-viewer]')).toBeNull();
      expect(view.queryByRole('link', { name: 'Open Floor plan.png' })).toBeNull();
      await settle();
      expect(view.getByRole('link', { name: /Download Policy.txt/ })).toBeDefined();
      view.unmount();
    },
  );

  test('revocation cancels a held read even when the transport ignores abort, then accepts only the new read', async () => {
    const old = Promise.withResolvers<{
      data: SharedLinkItem[];
      nextCursor: null;
      indexing: false;
    }>();
    const current = Promise.withResolvers<{
      data: SharedLinkItem[];
      nextCursor: null;
      indexing: false;
    }>();
    let calls = 0;
    const view = await visit({ shared: () => (++calls === 1 ? old.promise : current.promise) });
    act(() => {
      channelAccessRevoked(view.world.client, [IDS.api]);
    });
    await settle();
    await act(() => {
      old.resolve({ data: [link], nextCursor: null, indexing: false });
      return Promise.resolve();
    });
    await settle();
    expect(view.queryByRole('link', { name: 'Leave policy' })).toBeNull();
    await act(() => {
      current.resolve({ data: [], nextCursor: null, indexing: false });
      return Promise.resolve();
    });
    await settle();
    expect(view.getByRole('heading', { name: 'No shared links yet' })).toBeDefined();
    view.unmount();
  });
});
