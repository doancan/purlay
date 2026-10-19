/**
 * The door to a sidebar row's context menu (D-165) when the menu's chunk does not arrive: opening it
 * says so in a toast and nothing opens; a preload that failed says nothing; and the next opening asks
 * for the chunk again rather than remembering the failure.
 *
 * The chunk is made not to arrive as the image viewer's door test does it (`image-viewer-door.test.tsx`
 * says how): `app/deferred` is taken out of the registry and mocked with a module that fails, and put
 * back with its real exports; the door is a fresh copy, so no chunk fetched by another test is held.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { act, fireEvent } from '@testing-library/react';
import { settle } from '../../testing/channel-harness';
import { installDom } from '../../testing/dom';
import { IDS, aChannel, aSignedInApi } from '../../testing/fixtures';
import { renderApp } from '../../testing/render';
import { Toaster } from '../../ui/toast';
import { SessionGate } from '../session/session';
import { WorkspaceScopeProvider } from '../shell/workspace';
import type * as DoorModule from './row-menu';

installDom();

const DEFERRED = '../../app/deferred';
const UNAVAILABLE = 'The menu did not open. Check your connection and try again.';

const real = { ...(await import('../../app/deferred')) };

const PATH = require.resolve(DEFERRED);

let attempts = 0;

const failNextLoad = async (): Promise<void> => {
  Reflect.deleteProperty(require.cache, PATH);
  await mock.module(DEFERRED, () => {
    attempts += 1;
    throw new TypeError('Failed to fetch dynamically imported module');
  });
};

const goOnline = async (): Promise<void> => {
  Reflect.deleteProperty(require.cache, PATH);
  await mock.module(DEFERRED, () => real);
};

let door: typeof DoorModule;

beforeAll(async () => {
  const fresh = 'offline';
  door = (await import(`./row-menu?${fresh}`)) as typeof DoorModule;
});

afterAll(goOnline);

const Row = (): React.JSX.Element => {
  const { handlers, menu } = door.useRowMenu(aChannel(IDS.api, 'api'), false);
  return (
    <>
      <a href="#api" {...handlers}>
        api
      </a>
      {menu}
    </>
  );
};

describe('a menu that does not arrive', () => {
  test('says so in a toast, opens nothing, and opens on the next try once it can', async () => {
    const view = await renderApp(
      <SessionGate>
        <WorkspaceScopeProvider slug="acme" notFound={null}>
          <Toaster dismissLabel="Dismiss" />
          <Row />
        </WorkspaceScopeProvider>
      </SessionGate>,
      { api: aSignedInApi() },
    );
    await settle();
    const row = view.getByRole('link', { name: 'api' });

    await failNextLoad();
    act(() => {
      fireEvent.pointerEnter(row);
    });
    await settle();
    expect(attempts).toBe(1);
    expect(view.queryByText(UNAVAILABLE)).toBeNull();

    await failNextLoad();
    act(() => {
      fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
    });
    await settle();
    expect(attempts).toBe(2);
    expect(view.getByText(UNAVAILABLE)).toBeDefined();
    expect(view.queryByRole('menu')).toBeNull();

    await goOnline();
    act(() => {
      fireEvent.contextMenu(row, { clientX: 10, clientY: 10 });
    });
    await settle();
    expect(view.getByRole('menu', { name: 'Actions for #api' })).toBeDefined();
    view.unmount();
  });
});
