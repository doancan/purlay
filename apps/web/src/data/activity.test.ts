/** Explicit foreground intent is separate from a refetch, background producer or replay. */
import { expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { Type } from '@sinclair/typebox';
import { createApi } from './api';
import { createHttp } from './http';
import { isNewPageRequest } from './activity';
import { aMessage, IDS } from '../testing/fixtures';

test('only a new or explicitly paged query opts in; holding/refetching the same page does not', () => {
  const client = new QueryClient();
  const key = ['feed', IDS.api];
  expect(isNewPageRequest(client, key, undefined)).toBe(true);
  client.setQueryData(key, { pageParams: [undefined, 'before-2', { around: 'message' }] });
  expect(isNewPageRequest(client, key, undefined)).toBe(false);
  expect(isNewPageRequest(client, key, 'before-2')).toBe(false);
  expect(isNewPageRequest(client, key, { around: 'message' })).toBe(false);
  expect(isNewPageRequest(client, key, 'before-3')).toBe(true);
  client.clear();
});

test('activity is opt-in, re-read at fetch time, and never attached to default/replayed sends', async () => {
  const seen: RequestInit[] = [];
  let workspace: string | null = IDS.workspace;
  const http = createHttp(
    (_url, init) => {
      seen.push(init);
      return Promise.resolve(Response.json(aMessage(1)));
    },
    undefined,
    undefined,
    undefined,
    () => workspace,
  );
  const api = createApi(http);
  await api.send(IDS.api, { id: IDS.dm, content: 'background' });
  await api.send(IDS.api, { id: IDS.dm, content: 'actual user send' }, true);
  workspace = null;
  await api.send(IDS.api, { id: IDS.dm, content: 'hidden or settings' }, true);
  expect(new Headers(seen[0]?.headers).get('x-purlay-active-workspace')).toBeNull();
  expect(new Headers(seen[1]?.headers).get('x-purlay-active-workspace')).toBe(IDS.workspace);
  expect(new Headers(seen[2]?.headers).get('x-purlay-active-workspace')).toBeNull();
  workspace = IDS.browse;
  await http.request('GET', '/api/content', Type.Object({}), { activity: true });
  expect(new Headers(seen[3]?.headers).get('x-purlay-active-workspace')).toBe(IDS.browse);
});

test('resetting a held Query and automatically retrying its page do not manufacture new foreground intent', async () => {
  const client = new QueryClient();
  const key = ['feed', IDS.api];
  const create = (): void => {
    client.getQueryCache().build(client, client.defaultQueryOptions({ queryKey: key }));
  };
  create();
  expect(isNewPageRequest(client, key, undefined)).toBe(true);
  expect(isNewPageRequest(client, key, undefined)).toBe(false);
  client.setQueryData(key, { pageParams: [undefined] });
  await client.resetQueries({ queryKey: key, exact: true });
  expect(client.getQueryData(key)).toBeUndefined();
  expect(isNewPageRequest(client, key, undefined)).toBe(false);
  expect(isNewPageRequest(client, key, 'next-user-page')).toBe(true);
  expect(isNewPageRequest(client, key, 'next-user-page')).toBe(false);
  client.removeQueries({ queryKey: key, exact: true });
  create();
  expect(isNewPageRequest(client, key, undefined)).toBe(true);
  client.clear();
});
