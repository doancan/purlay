/** A star and a move share the same ordered line, while other channels remain independent. */
import { expect, test } from 'bun:test';
import { QueryClient } from '@tanstack/react-query';
import { sidebarLedger, sidebarWrite } from './sidebar-writes';

test('writes on one channel keep click order and refresh only once after the last', async () => {
  const client = new QueryClient();
  const held = Promise.withResolvers<undefined>();
  const calls: string[] = [];
  const first = sidebarWrite(
    client,
    'channel',
    async () => {
      calls.push('star');
      await held.promise;
      return 'starred';
    },
    () => {
      calls.push('idle first');
    },
  );
  const second = sidebarWrite(
    client,
    'channel',
    () => {
      calls.push('move');
      return Promise.resolve('group');
    },
    () => {
      calls.push('idle last');
    },
  );
  await Promise.resolve();
  expect(calls).toEqual(['star']);
  held.resolve(undefined);
  expect(await first).toBe('starred');
  expect(await second).toBe('group');
  await Promise.resolve();
  expect(calls).toEqual(['star', 'move', 'idle last']);
  await sidebarWrite(
    client,
    'channel',
    () => {
      calls.push('next');
      return Promise.resolve();
    },
    () => {
      calls.push('idle next');
    },
  );
  await Promise.resolve();
  expect(calls.slice(-2)).toEqual(['next', 'idle next']);
});

test('a refused write does not block a later move', async () => {
  const client = new QueryClient();
  const failure = new Error('offline');
  const first = sidebarWrite(
    client,
    'channel',
    () => Promise.reject(failure),
    () => undefined,
  );
  const next = sidebarWrite(
    client,
    'channel',
    () => Promise.resolve('moved'),
    () => undefined,
  );
  const refusal: unknown = await first.catch((reason: unknown) => reason);
  expect(refusal).toBe(failure);
  expect(await next).toBe('moved');
});

test('different channels and different clients do not wait for one another', async () => {
  const client = new QueryClient();
  const other = new QueryClient();
  const held = Promise.withResolvers<undefined>();
  const first = sidebarWrite(
    client,
    'one',
    async () => {
      await held.promise;
    },
    () => undefined,
  );
  expect(
    await sidebarWrite(
      client,
      'two',
      () => Promise.resolve('two'),
      () => undefined,
    ),
  ).toBe('two');
  expect(
    await sidebarWrite(
      other,
      'one',
      () => Promise.resolve('other'),
      () => undefined,
    ),
  ).toBe('other');
  held.resolve(undefined);
  await first;
});

test('a failed later intention restores the accepted answer, including when the same transformation was reused', async () => {
  const ledger = sidebarLedger<number>();
  const client = new QueryClient();
  let value = 0;
  const firstAnswer = Promise.withResolvers<number>();
  const secondAnswer = Promise.withResolvers<number>();
  const apply = (before: number): number => before + 1;
  const send = (answer: Promise<number>): Promise<number> =>
    ledger.send({
      client,
      key: 'one',
      queueKey: 'one',
      read: () => value,
      paint: (next) => {
        value = next;
      },
      apply,
      write: async () => await answer,
      accepted: (_before, result) => result,
      refresh: () => undefined,
    });
  const first = send(firstAnswer.promise);
  const second = send(secondAnswer.promise).catch((failure: unknown) => failure);
  expect(value).toBe(2);
  firstAnswer.resolve(10);
  await first;
  expect(value).toBe(11);
  const offline = new Error('offline');
  secondAnswer.reject(offline);
  expect(await second).toBe(offline);
  expect(value).toBe(10);
  expect(await send(Promise.resolve(20))).toBe(20);
  expect(value).toBe(20);
});
