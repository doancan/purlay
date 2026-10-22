import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { renderHook } from '@testing-library/react';
import { installDom } from '../../testing/dom';
import type { ServerClient } from './server-client';
import { ServerClientProvider, useServerClient } from './server-context';

installDom();

let network: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | null = null;
afterEach(() => {
  network?.mockRestore();
  network = null;
});

describe('the client the Server cards call through', () => {
  test('is the one a provider gives', () => {
    const given: ServerClient = {
      settings: () => Promise.reject(new Error('unused')),
      github: () => Promise.reject(new Error('unused')),
      smtp: () => Promise.reject(new Error('unused')),
      disconnect: () => Promise.reject(new Error('unused')),
      policy: () => Promise.reject(new Error('unused')),
      creators: () => Promise.reject(new Error('unused')),
    };
    const { result } = renderHook(() => useServerClient(), {
      wrapper: ({ children }) => (
        <ServerClientProvider value={given}>{children}</ServerClientProvider>
      ),
    });
    expect(result.current).toBe(given);
  });

  test('is, with no provider, one that asks the platform’s fetch', async () => {
    network = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}'));
    const { result } = renderHook(() => useServerClient());
    const verdict = await result.current.github({ clientId: 'a', clientSecret: 'b' });
    expect(verdict).toEqual({ ok: true });
    expect(network).toHaveBeenCalledTimes(1);
    expect(network.mock.calls[0]?.[0]).toBe('/api/server/github');
  });
});
