/**
 * A module's route the server has closed (D-250, `DEPLOY.md` rolling deploys): the page was drawn from a node that
 * runs chat and a request reached one that does not, which answers `404 ROUTE_NOT_FOUND`. The session is read
 * again, once, and the gate hides what the server no longer lists.
 */
import { waitFor } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';
import { ApiError } from '../data/errors';
import { keys } from '../data/keys';
import type { MeResponse } from '@purlay/types';
import type { Api } from '../data/api';
import { installDom } from '../testing/dom';
import { IDS, aSession, aSignedInApi } from '../testing/fixtures';
import { renderApp } from '../testing/render';
import { Outlet } from './outlet';

installDom();

const closed = (): ApiError => new ApiError(404, 'ROUTE_NOT_FOUND', 'no such route');

/** A `me` that counts its reads and lists what `modulesOf` says for the nth. */
const countingMe = (
  modulesOf: (read: number) => string[],
): { readonly me: Api['me']; readonly reads: () => number } => {
  let reads = 0;
  return {
    me: (): Promise<MeResponse> => {
      reads += 1;
      return Promise.resolve({ ...aSession(), modules: modulesOf(reads) });
    },
    reads: () => reads,
  };
};

describe('a 404 for a route a module owns', () => {
  test('reads the session again, and the chat screen gives way to not found with no further chat request', async () => {
    const session = countingMe((read) => (read === 1 ? ['chat'] : []));
    let channelReads = 0;
    const api = aSignedInApi({
      me: session.me,
      channels: () => {
        channelReads += 1;
        return Promise.reject(closed());
      },
    });
    const view = await renderApp(<Outlet />, { path: `/w/acme/c/${IDS.api}`, api });
    expect(await view.findByRole('heading', { level: 1, name: 'Nothing here' })).toBeDefined();
    expect(session.reads()).toBe(2);
    const asked = channelReads;
    await view.world.client.invalidateQueries({ queryKey: keys.me, exact: true });
    expect(channelReads).toBe(asked);
  });

  test('a mixed cluster, where the session still lists the module, reads it once and does nothing more', async () => {
    const session = countingMe(() => ['chat']);
    const api = aSignedInApi({ me: session.me, channels: () => Promise.reject(closed()) });
    const view = await renderApp(<Outlet />, { path: `/w/acme/c/${IDS.api}`, api });
    await waitFor(() => {
      expect(session.reads()).toBe(2);
    });
    await waitFor(() => {
      expect(view.world.client.isFetching()).toBe(0);
    });
    expect(session.reads()).toBe(2);
  });

  test('a burst of them is one read of the session', async () => {
    const session = countingMe(() => ['chat']);
    const view = await renderApp(<Outlet />, {
      path: '/w/acme/settings',
      api: aSignedInApi({ me: session.me }),
    });
    await view.findByRole('main');
    const before = session.reads();
    const { client } = view.world;
    await Promise.allSettled(
      [1, 2, 3, 4].map((n) =>
        client.query({
          queryKey: ['burst', n],
          queryFn: () => Promise.reject(closed()),
          retry: false,
        }),
      ),
    );
    await waitFor(() => {
      expect(client.isFetching()).toBe(0);
    });
    expect(session.reads() - before).toBe(1);
  });

  test('a failed write is read the same way', async () => {
    const session = countingMe(() => ['chat']);
    const view = await renderApp(<Outlet />, {
      path: '/w/acme/settings',
      api: aSignedInApi({ me: session.me }),
    });
    await view.findByRole('main');
    const before = session.reads();
    const { client } = view.world;
    await client
      .getMutationCache()
      .build(client, { mutationFn: () => Promise.reject(closed()) })
      .execute(undefined)
      .catch(() => undefined);
    expect(session.reads() - before).toBe(1);
  });
});

describe('a failure that is not a closed module route', () => {
  test.each([
    new ApiError(404, 'CHANNEL_NOT_FOUND', 'no such channel'),
    new ApiError(503, 'DATABASE_UNAVAILABLE', 'busy'),
  ])('%p does not read the session again', async (error) => {
    const session = countingMe(() => ['chat']);
    const view = await renderApp(<Outlet />, {
      path: '/w/acme/settings',
      api: aSignedInApi({ me: session.me }),
    });
    await view.findByRole('main');
    const before = session.reads();
    await view.world.client
      .query({ queryKey: ['elsewhere'], queryFn: () => Promise.reject(error), retry: false })
      .catch(() => undefined);
    expect(session.reads()).toBe(before);
  });

  test('the session’s own failing never reads it again: no loop', async () => {
    let reads = 0;
    const api = aSignedInApi({
      me: () => {
        reads += 1;
        return Promise.reject(closed());
      },
    });
    const view = await renderApp(<Outlet />, { path: '/w/acme/settings', api });
    await view.findByRole('button', { name: /retry/iu });
    expect(reads).toBe(1);
  });
});
