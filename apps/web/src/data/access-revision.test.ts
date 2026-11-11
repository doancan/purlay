/** Old content work cannot survive a scoped access reset, query replacement or an account clear. */
import { describe, expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { aChannel, IDS } from '../testing/fixtures';
import { anApi } from '../testing/fake-api';
import { captureAccess, watchAccessChanges } from './access-revision';
import { channelAccessRevoked, workspaceAccessChanged } from './access-change';
import { createActions } from './actions';
import { keys } from './keys';

describe('content access tickets', () => {
  test('scoped resets invalidate only the selected resources in their own client, before notifying overlays', () => {
    const here = new QueryClient();
    const elsewhere = new QueryClient();
    const key = keys.pins(IDS.api);
    const retained = keys.pins('other-channel');
    here.setQueryData(keys.channels(IDS.workspace), [aChannel(IDS.api, 'here')]);
    here.setQueryData(keys.channels('other-workspace'), [
      aChannel('other-channel', 'other', { workspaceId: 'other-workspace' }),
    ]);
    for (const client of [here, elsewhere]) client.setQueryData(key, []);
    here.setQueryData(retained, []);
    const old = captureAccess(here, key);
    const otherResource = captureAccess(here, retained);
    const otherClient = captureAccess(elsewhere, key);
    const seen: boolean[] = [];
    let foreignNotifications = 0;
    const stop = watchAccessChanges(here, () => {
      seen.push(old());
    });
    const stopOther = watchAccessChanges(elsewhere, () => {
      foreignNotifications++;
    });
    workspaceAccessChanged(here, IDS.workspace);
    expect(old()).toBe(false);
    expect(otherResource()).toBe(true);
    expect(otherClient()).toBe(true);
    expect(seen).toEqual([false]);
    expect(foreignNotifications).toBe(0);
    const fresh = captureAccess(here, key);
    expect(fresh()).toBe(true);
    channelAccessRevoked(here, [IDS.api]);
    expect(fresh()).toBe(false);
    expect(old()).toBe(false);
    expect(seen).toEqual([false, false]);
    stop();
    stop();
    stopOther();
    workspaceAccessChanged(here, IDS.workspace);
    expect(seen).toEqual([false, false]);
    here.clear();
    elsewhere.clear();
  });

  test('removing and recreating the same key cannot revive an old ticket, while ordinary reads retain it', async () => {
    const client = new QueryClient();
    const key = keys.pins(IDS.api);
    client.setQueryData(key, []);
    const old = captureAccess(client, key);
    await client.query({ queryKey: key, queryFn: () => Promise.resolve([]) });
    expect(old()).toBe(true);
    client.clear();
    client.setQueryData(key, []);
    expect(old()).toBe(false);
    expect(captureAccess(client, key)()).toBe(true);
    const absent = captureAccess(client, keys.pins('absent'));
    client.setQueryData(keys.pins('absent'), []);
    expect(absent()).toBe(false);
    expect(captureAccess(client, keys.pins('absent'))()).toBe(true);
    client.clear();
  });

  test.each(['sign-out', 'erase', 'link-sign-in'] as const)(
    'successful %s clears resource identity before optimistic subscribers are notified',
    async (operation) => {
      const client = new QueryClient();
      const key = keys.pins(IDS.api);
      client.setQueryData(key, []);
      const old = captureAccess(client, key);
      const seen: boolean[] = [];
      const stop = watchAccessChanges(client, () => {
        seen.push(old());
      });
      const actions = createActions(
        anApi({
          signOut: () => Promise.resolve(),
          eraseAccount: () => Promise.resolve(),
          consumeEmailSignIn: () => Promise.resolve(),
        }),
        client,
      );
      if (operation === 'sign-out') await actions.signOut();
      else if (operation === 'erase') await actions.eraseAccount('alice');
      else await actions.signInByLink('a'.repeat(64));
      expect(seen).toEqual([false]);
      expect(old()).toBe(false);
      client.setQueryData(key, []);
      expect(old()).toBe(false);
      stop();
      client.clear();
    },
  );
});
