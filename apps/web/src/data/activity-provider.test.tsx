/** Real browser assembly: route, current membership, visibility and focus are sampled per request. */
import { expect, spyOn, test } from 'bun:test';
import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { ApiProvider, BrowserApiProvider, useApi } from './api-provider';
import type { Api } from './api';
import { keys } from './keys';
import { installDom } from '../testing/dom';
import { aChannel, aMessage, aSession, IDS } from '../testing/fixtures';
import { fakeHistory } from '../testing/fakes';
import { RouterProvider, useRoute } from '../router/router-provider';
import { href } from '../router/routes';
import { workspaceAccessRequiredKey } from './access-change';
import { isApiError } from './errors';

installDom();
test('foreground activity follows content navigation without recreating the API; settings, hidden and unfocused tabs stay quiet', async () => {
  const original = Object.getOwnPropertyDescriptor(document, 'visibilityState');
  let visible = true;
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (visible ? 'visible' : 'hidden'),
  });
  const focus = spyOn(document, 'hasFocus').mockReturnValue(true);
  const requests: RequestInit[] = [];
  const respond = Object.assign(
    (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ): Promise<Response> => {
      requests.push(init ?? {});
      return Promise.resolve(Response.json(aMessage(1)));
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  const transport = spyOn(globalThis, 'fetch').mockImplementation(respond);
  const client = new QueryClient();
  client.setQueryData(keys.me, aSession());
  const history = fakeHistory(href('channel', { slug: 'acme', channelId: IDS.api }));
  const identities: Api[] = [];
  const Probe = (): React.JSX.Element => {
    const api = useApi();
    const { navigate } = useRoute();
    useEffect(() => {
      identities.push(api);
    }, [api]);
    return (
      <>
        <button
          onClick={() => {
            navigate(href('settings', { slug: 'acme', section: 'security' }));
          }}
        >
          Settings
        </button>
        <button
          onClick={() => {
            navigate('/workspace-access?workspace=acme');
          }}
        >
          Remediation
        </button>
        <button
          onClick={() => {
            navigate(href('channel', { slug: 'acme', channelId: IDS.api }));
          }}
        >
          Content
        </button>
        <button
          onClick={() => {
            void api.send(IDS.api, { id: IDS.dm, content: 'foreground' }, true);
          }}
        >
          Send
        </button>
        <button
          onClick={() => {
            void api.send(IDS.api, { id: IDS.dm, content: 'background' });
          }}
        >
          Background
        </button>
      </>
    );
  };
  const view = render(
    <RouterProvider history={history}>
      <QueryClientProvider client={client}>
        <BrowserApiProvider>
          <Probe />
        </BrowserApiProvider>
      </QueryClientProvider>
    </RouterProvider>,
  );
  try {
    fireEvent.click(view.getByText('Send'));
    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    visible = false;
    fireEvent.click(view.getByText('Send'));
    await waitFor(() => {
      expect(requests).toHaveLength(2);
    });
    visible = true;
    focus.mockReturnValue(false);
    fireEvent.click(view.getByText('Send'));
    await waitFor(() => {
      expect(requests).toHaveLength(3);
    });
    focus.mockReturnValue(true);
    fireEvent.click(view.getByText('Settings'));
    await waitFor(() => {
      expect(history.read().pathname).toContain('/settings/');
    });
    fireEvent.click(view.getByText('Send'));
    await waitFor(() => {
      expect(requests).toHaveLength(4);
    });
    fireEvent.click(view.getByText('Remediation'));
    fireEvent.click(view.getByText('Send'));
    await waitFor(() => {
      expect(requests).toHaveLength(5);
    });
    fireEvent.click(view.getByText('Content'));
    fireEvent.click(view.getByText('Background'));
    await waitFor(() => {
      expect(requests).toHaveLength(6);
    });
    expect(
      requests.map((request) => new Headers(request.headers).get('x-purlay-active-workspace')),
    ).toEqual([IDS.workspace, null, null, null, null, null]);
    expect(identities).toHaveLength(1);
  } finally {
    view.unmount();
    client.clear();
    focus.mockRestore();
    transport.mockRestore();
    if (original) Object.defineProperty(document, 'visibilityState', original);
    else Reflect.deleteProperty(document, 'visibilityState');
  }
});

test('the default HTTP provider clears only a canonical denied workspace before returning the failure', async () => {
  const client = new QueryClient();
  client.setQueryData(keys.me, aSession());
  const elsewhere = [aChannel(IDS.dm, 'other', { workspaceId: IDS.browse })];
  client.setQueryData(keys.channels(IDS.workspace), [aChannel(IDS.api, 'private')]);
  client.setQueryData(keys.channels(IDS.browse), elsewhere);
  let hint: string = IDS.workspace;
  const respond = Object.assign(
    (): Promise<Response> =>
      Promise.resolve(
        Response.json(
          {
            error: {
              code: 'WORKSPACE_ACCESS_REQUIRED',
              message: 'verify',
              details: { workspaceId: hint },
            },
          },
          { status: 403 },
        ),
      ),
    { preconnect: globalThis.fetch.preconnect },
  );
  const transport = spyOn(globalThis, 'fetch').mockImplementation(respond);
  let api: Api | undefined;
  const Probe = (): null => {
    api = useApi();
    return null;
  };
  const view = render(
    <QueryClientProvider client={client}>
      <ApiProvider>
        <Probe />
      </ApiProvider>
    </QueryClientProvider>,
  );
  try {
    if (api === undefined) throw new Error('API provider not mounted');
    const current = api;
    await act(async () => {
      const failure: unknown = await current
        .channels(IDS.workspace)
        .catch((error: unknown) => error);
      expect(isApiError(failure) && failure.workspaceId === IDS.workspace).toBe(true);
    });
    expect(client.getQueryData(keys.channels(IDS.workspace))).toBeUndefined();
    expect(client.getQueryData(keys.channels(IDS.browse))).toEqual(elsewhere);
    expect(client.getQueryData(keys.me)).toBeDefined();
    expect(client.getQueryData(workspaceAccessRequiredKey(IDS.workspace, IDS.me))).toBe(true);
    hint = IDS.bob;
    await current.channels(IDS.bob).catch(() => undefined);
    expect(client.getQueryData(workspaceAccessRequiredKey(IDS.bob, IDS.me))).toBeUndefined();
  } finally {
    view.unmount();
    client.clear();
    transport.mockRestore();
  }
});
