/**
 * The signed-in frame on a server that runs no module (D-250): the core's screens stand, and nothing of chat is drawn
 * or asked for. The API is the strict fake, so a request for what chat answers fails the test by its name.
 */
import { describe, expect, test } from 'bun:test';
import { act } from '@testing-library/react';
import type { ModuleId } from '@purlay/types';
import { Outlet } from '../../app/outlet';
import type { Api } from '../../data/api';
import { installDom } from '../../testing/dom';
import { anApi } from '../../testing/fake-api';
import { aSession, someMembers } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';

installDom();

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 4; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

/** What the core's own frame asks for, and the names of everything it asked: a request a query swallows is still seen. */
const coreOnlyApi = (modules: readonly ModuleId[]): { api: Api; asked: string[] } => {
  const base = anApi({
    me: () => Promise.resolve({ ...aSession(), modules: [...modules] }),
    members: () => Promise.resolve(someMembers()),
    // Answered, so that a frame that runs chat is seen asking and the test is not vacuous.
    channels: () => Promise.resolve([]),
    quietHours: () => Promise.resolve({ quietHours: null, timeZone: null }),
  });
  const asked: string[] = [];
  const api = new Proxy(base, {
    get: (target, name: string): unknown => {
      const method = target[name as keyof Api] as unknown;
      if (typeof method !== 'function') return method;
      return (...args: unknown[]): unknown => {
        asked.push(name);
        return (method as (...given: unknown[]) => unknown)(...args);
      };
    },
  });
  return { api, asked };
};

describe('the frame with no module', () => {
  test('the workspace’s front door offers its settings, and the frame asks for nothing of chat', async () => {
    const { api, asked } = coreOnlyApi([]);
    const view = await renderApp(<Outlet />, { path: '/w/acme', api });
    await settle();
    expect(view.getByRole('heading', { level: 1, name: 'Your workspace' })).toBeDefined();
    // Settings stays in the rail, and the front door offers it too.
    expect(view.getAllByRole('link', { name: 'Settings' }).length).toBeGreaterThanOrEqual(2);
    // The rail and the sidebar draw no chat entry.
    expect(view.queryByRole('link', { name: 'Inbox' })).toBeNull();
    expect(view.queryByRole('link', { name: 'Saved' })).toBeNull();
    expect(view.queryByRole('link', { name: 'Drafts' })).toBeNull();
    expect(asked).toContain('me');
    for (const chat of ['channels', 'presence', 'unresolved', 'savedIds', 'pins', 'bookmarks']) {
      expect(asked).not.toContain(chat);
    }
  });

  test('with chat it asks for the channels: the check above sees what it looks for', async () => {
    const { api, asked } = coreOnlyApi(['chat']);
    await renderApp(<Outlet />, { path: '/w/acme', api });
    await settle();
    expect(asked).toContain('channels');
  });
});
