import { describe, expect, test } from 'bun:test';
import { hookList } from './hooks';

describe('a list of hooks', () => {
  test('runs each in the order it was registered, each to the end before the next', async () => {
    const hooks = hookList<[string]>();
    const seen: string[] = [];
    hooks.register(async (name) => {
      await Bun.sleep(5);
      seen.push(`first:${name}`);
    });
    hooks.register((name) => {
      seen.push(`second:${name}`);
      return Promise.resolve();
    });
    await hooks.run('ws');
    expect(seen).toEqual(['first:ws', 'second:ws']);
  });

  test('with none registered does nothing', async () => {
    await hookList<[]>().run();
  });

  test('stops at the first that throws, and throws what it threw', async () => {
    const hooks = hookList<[]>();
    const seen: string[] = [];
    hooks.register(() => Promise.reject(new Error('the first failed')));
    hooks.register(() => {
      seen.push('never');
      return Promise.resolve();
    });
    let thrown: unknown;
    try {
      await hooks.run();
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).toContain('the first failed');
    expect(seen).toEqual([]);
  });
});
