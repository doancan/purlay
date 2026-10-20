/**
 * The door to the image viewer (D-159) when the viewer's chunk does not arrive: the click says so in
 * a toast and nothing opens; a preload that failed says nothing, the click after it says it once;
 * and the next click asks for the chunk again rather than remembering the failure.
 *
 * **How the chunk is made not to arrive.** The door asks for `app/deferred` with `import()`, and the
 * test process has one module registry for every file, so that module is usually loaded already. It
 * is taken out of the registry and mocked with a module that fails to load; "back online" mocks it
 * with the real module's own exports, which is what it stays for the rest of the process — every
 * other door gets exactly what it got before. The door itself is a fresh copy (`?offline`): the one
 * the rest of the suite uses may hold a chunk it already fetched.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { act, fireEvent } from '@testing-library/react';
import type { Attachment } from '@purlay/types';
import { settle } from '../../testing/channel-harness';
import { installDom } from '../../testing/dom';
import { renderApp } from '../../testing/render';
import { person } from '../../testing/user';
import { Toaster } from '../../ui/toast';
import type * as DoorModule from './image-viewer-door';

installDom();

const DEFERRED = '../../app/deferred';
const UNAVAILABLE = 'The image viewer did not open. Check your connection and try again.';

// Its exports, held apart from the module: a mock replaces what the module's own record holds.
const real = { ...(await import('../../app/deferred')) };

const PATH = require.resolve(DEFERRED);

/**
 * The next `import()` of the chunk fails. One failure each: a module that failed is remembered by
 * the registry as an empty one, so it is taken out again before every attempt.
 */
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
  door = (await import(`./image-viewer-door?${fresh}`)) as typeof DoorModule;
});

afterAll(goOnline);

const PICTURE: Attachment = {
  id: '01995f7b-0000-7000-8000-000000000001',
  fileName: 'diagram.png',
  mimeType: 'image/png',
  sizeBytes: 1024,
  kind: 'image',
  width: 800,
  height: 600,
};

const Thumbnail = (): React.JSX.Element => {
  const { open, preload, viewer } = door.useImageViewer();
  return (
    <>
      <button
        type="button"
        onPointerEnter={preload}
        onClick={(event) => {
          open(
            [{ attachment: PICTURE, sharedBy: 'Ayşe', sharedAt: '2026-09-09T11:55:00.000Z' }],
            0,
            event.currentTarget,
          );
        }}
      >
        diagram.png
      </button>
      {viewer}
    </>
  );
};

const mount = (): ReturnType<typeof renderApp> =>
  renderApp(
    <>
      <Toaster dismissLabel="Dismiss" />
      <Thumbnail />
    </>,
  );

describe('a viewer that does not arrive', () => {
  test('says so in a toast, opens nothing, and opens on the next click once it can', async () => {
    const view = await mount();
    const thumbnail = view.getByRole('button', { name: 'diagram.png' });

    // Pointed at first: the preload fails, and says nothing.
    await failNextLoad();
    act(() => {
      fireEvent.pointerEnter(thumbnail);
    });
    await settle();
    expect(attempts).toBe(1);
    expect(view.queryByText(UNAVAILABLE)).toBeNull();

    // Clicked without moving the pointer again: one more attempt, and it fails too.
    await failNextLoad();
    act(() => {
      fireEvent.click(thumbnail);
    });
    await settle();
    expect(attempts).toBe(2);
    expect(view.getAllByText(UNAVAILABLE)).toHaveLength(1);
    expect(view.queryByRole('dialog')).toBeNull();

    // The connection is back: the click asks again, and the viewer opens.
    await goOnline();
    await person().click(thumbnail);
    await settle();
    expect(view.getByRole('dialog')).toBeDefined();
    expect(view.getByRole('heading', { name: 'diagram.png' })).toBeDefined();
    view.unmount();
  });
});
