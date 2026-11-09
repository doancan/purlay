import { describe, expect, test } from 'bun:test';
import { installDom } from '../../testing/dom';
import { resetStorageNotes } from '../../data/browser-storage';
import { TestLocks } from '../../testing/locks';
import { memoryStorage } from '../../testing/fakes';
import { claimAlert, holdFocus } from './coordination';

installDom();

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
    const options = setup();
    let shown = 0;
    expect(
      await claimAlert({
        ...options,
        storage: {
          ...(options.storage ?? memoryStorage()),
          setItem: () => {
            throw new Error('Blocked');
          },
        },
        show: (): boolean => {
          shown += 1;
          return true;
        },
      }),
    ).toBe(false);
    expect(shown).toBe(0);
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
  test.each(['{broken', JSON.stringify(['old', 42, 'x'.repeat(201)])])(
    'damaged or untrusted claim entries cannot prevent the next notice: %s',
    async (stored) => {
      const options = setup();
      options.storage?.setItem('purlay.push.claims.workspace', stored);
      expect(await claimAlert(options)).toBe(true);
      expect(options.storage?.getItem('purlay.push.claims.workspace')).toBe(
        JSON.stringify(stored === '{broken' ? ['notice'] : ['old', 'notice']),
      );
      expect(await claimAlert(options)).toBe(false);
    },
  );
  test('a refused native lock stays quiet and leaves an inspectable failure', async () => {
    class RefusedLocks extends TestLocks {
      override request<T>(): Promise<T> {
        return Promise.reject(new DOMException('Blocked', 'SecurityError'));
      }
    }
    resetStorageNotes();
    const options = { ...setup(), locks: new RefusedLocks() };
    const release = holdFocus(options.locks, options.scope);
    await Promise.resolve();
    await Promise.resolve();
    expect(await claimAlert(options)).toBe(false);
    expect(document.documentElement.dataset['storageFailed']).toContain('alert-focus');
    expect(document.documentElement.dataset['storageFailed']).toContain('alert-lock');
    release();
  });
});
