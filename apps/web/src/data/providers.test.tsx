/**
 * What the providers hand down, and what happens when a screen asks without one above it.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { act, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { installDom } from '../testing/dom';
import { errorOf } from '../testing/boundary';
import { anApi } from '../testing/fake-api';
import { ActionsProvider, useActions } from './actions-provider';
import { ApiProvider, useApi } from './api-provider';

installDom();

describe('asking without a provider', () => {
  test('useApi says what is missing', () => {
    const Probe = (): null => {
      useApi();
      return null;
    };
    expect(errorOf(<Probe />)).toBe('useApi was called outside an ApiProvider');
  });

  test('useActions says what is missing', () => {
    const Probe = (): null => {
      useActions();
      return null;
    };
    expect(errorOf(<Probe />)).toBe('useActions was called outside an ActionsProvider');
  });
});

describe('the API', () => {
  test('is the one it was given', () => {
    const api = anApi();
    let seen: unknown;
    const Probe = (): null => {
      seen = useApi();
      return null;
    };
    render(
      <ApiProvider api={api}>
        <Probe />
      </ApiProvider>,
    );
    expect(seen).toBe(api);
  });

  test("is, by default, the browser's fetch on the same origin", async () => {
    const asked: string[] = [];
    const spy = spyOn(globalThis, 'fetch').mockImplementation(((url: string) => {
      asked.push(url);
      return Promise.resolve(new Response('[]', { status: 200 }));
    }) as unknown as typeof fetch);
    let call: () => Promise<unknown> = () => Promise.resolve();
    const Probe = (): null => {
      const api = useApi();
      call = (): Promise<unknown> => api.workspaces();
      return null;
    };
    render(
      <ApiProvider>
        <Probe />
      </ApiProvider>,
    );
    await act(async () => {
      await call();
    });
    expect(asked).toEqual(['/api/workspaces']);
    spy.mockRestore();
  });
});

describe('the actions', () => {
  test('are built over the API and cache above them', () => {
    const client = new QueryClient();
    let seen: unknown;
    const Probe = (): null => {
      seen = useActions();
      return null;
    };
    render(
      <QueryClientProvider client={client}>
        <ApiProvider api={anApi()}>
          <ActionsProvider>
            <Probe />
          </ActionsProvider>
        </ApiProvider>
      </QueryClientProvider>,
    );
    expect(typeof (seen as { react: unknown }).react).toBe('function');
  });
});
