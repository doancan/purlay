import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { installPdfCompatibility } from './pdf-compat';

interface Capability<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason: unknown) => void;
}

const original = Object.getOwnPropertyDescriptor(Promise, 'withResolvers');
afterEach(() => {
  if (original === undefined) Reflect.deleteProperty(Promise, 'withResolvers');
  else Object.defineProperty(Promise, 'withResolvers', original);
});

test('keeps an existing native implementation unchanged', () => {
  const before: unknown = Reflect.get(Promise, 'withResolvers');
  installPdfCompatibility();
  const after: unknown = Reflect.get(Promise, 'withResolvers');
  expect(after).toBe(before);
});

test('an absent API resolves values and thenables, and rejects with the original reason', async () => {
  Object.defineProperty(Promise, 'withResolvers', {
    configurable: true,
    writable: true,
    value: undefined,
  });
  installPdfCompatibility();
  const constructor = Promise as PromiseConstructor & {
    withResolvers: <T>() => Capability<T>;
  };
  const one = constructor.withResolvers<string>();
  one.resolve(Promise.resolve('İstanbul'));
  expect(await one.promise).toBe('İstanbul');
  const two = constructor.withResolvers<number>();
  two.resolve(42);
  expect(await two.promise).toBe(42);
  const three = constructor.withResolvers<never>();
  const reason = new Error('unreadable PDF');
  three.reject(reason);
  expect(await three.promise.catch((error: unknown) => error)).toBe(reason);
});

test('the standard generic constructor receiver is preserved', async () => {
  Reflect.deleteProperty(Promise, 'withResolvers');
  installPdfCompatibility();
  class DocumentPromise<T> extends Promise<T> {}
  const make: unknown = Reflect.get(Promise, 'withResolvers');
  expect(typeof make).toBe('function');
  if (typeof make !== 'function') throw new Error('missing compatibility method');
  const result = Reflect.apply(make, DocumentPromise, []) as Capability<number>;
  expect(result.promise).toBeInstanceOf(DocumentPromise);
  result.resolve(8);
  expect(await result.promise).toBe(8);
});

test('importing the compatibility entry repairs the realm before an SDK can evaluate', () => {
  // A real fresh process: Bun caches a module even when its import URL has another query string.
  const entry = new URL('./pdf-compat.ts', import.meta.url).href;
  const script = `Reflect.deleteProperty(Promise, 'withResolvers'); await import(${JSON.stringify(entry)}); console.log(typeof Reflect.get(Promise, 'withResolvers'));`;
  const result = spawnSync(process.execPath, ['--no-env-file', '--eval', script], {
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe('function');
});
