import { describe, expect, test } from 'bun:test';
import { TestLocks } from '../../testing/locks';
import { memoryStorage } from '../../testing/fakes';
import { claimAlert, holdFocus } from './coordination';

describe('tabs sharing an alert', () => {
  const setup = (): Parameters<typeof claimAlert>[0] => {
    const storage = memoryStorage();
    storage.setItem('purlay.person', 'alice');
    return {
      locks: new TestLocks(),
      storage,
      userId: 'alice',
      scope: 'workspace',
      id: 'notice',
      eligible: () => true,
      focused: () => false,
      show: () => true,
    };
  };
  test('concurrent tabs claim a message once; the next message can alert again', async () => {
    const options = setup();
    expect(await Promise.all([claimAlert(options), claimAlert(options)])).toEqual([true, false]);
    expect(await claimAlert({ ...options, id: 'next' })).toBe(true);
  });
  test('a focused tab owns the interruption even when a background tab gets the event first', async () => {
    const options = setup();
    if (options.locks === null) throw new Error('Missing test locks');
    const release = holdFocus(options.locks, options.scope);
    await Promise.resolve();
    expect(await claimAlert(options)).toBe(false);
    expect(await claimAlert({ ...options, focused: () => true })).toBe(true);
    release();
    expect(await claimAlert({ ...options, id: 'after-blur' })).toBe(true);
  });
  test('read, revoked or signed-out state cannot claim a delayed notice', async () => {
    const options = setup();
    expect(await claimAlert({ ...options, eligible: () => false })).toBe(false);
    options.storage?.setItem('purlay.person', 'bob');
    expect(await claimAlert(options)).toBe(false);
  });
  test('blocked storage and missing coordination never cause duplicate background sounds', async () => {
    expect(await claimAlert({ ...setup(), locks: null })).toBe(false);
    expect(await claimAlert({ ...setup(), storage: null })).toBe(false);
    expect(await claimAlert({ ...setup(), locks: null, focused: () => true })).toBe(true);
    expect(
      await claimAlert({
        ...setup(),
        storage: {
          ...memoryStorage(),
          setItem: () => {
            throw new Error('Blocked');
          },
        },
      }),
    ).toBe(false);
  });
  test('tenfold traffic keeps a bounded, content-free claim list', async () => {
    const options = setup();
    for (let i = 0; i < 1000; i++) await claimAlert({ ...options, id: `id-${String(i)}` });
    const held: unknown = JSON.parse(
      options.storage?.getItem('purlay.push.claims.workspace') ?? 'null',
    );
    expect(held).toBeArrayOfSize(100);
    expect(await claimAlert({ ...options, id: 'id-999' })).toBe(false);
  });
});
