import { isClaimedBy, noteStorageFailure, type ClientStorage } from '../../data/browser-storage';

/** A live focus lease needs no clock, heartbeat or stale stored presence. Closing a tab releases it. */
export const holdFocus = (locks: LockManager, scope: string): (() => void) => {
  const pending = new AbortController();
  let release: (() => void) | undefined;
  void locks
    .request(
      `${scope}:focus`,
      { mode: 'shared', signal: pending.signal },
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    )
    .catch((error: unknown): void => {
      if (!(error instanceof DOMException && error.name === 'AbortError'))
        noteStorageFailure('alert-focus');
    });
  return (): void => {
    pending.abort();
    release?.();
  };
};

/** Content-free bounded claims under one native cross-tab lock; never a read/modify/write race. */
export const claimAlert = async ({
  locks,
  storage,
  userId,
  scope,
  id,
  eligible,
  focused,
  show,
}: {
  readonly locks: LockManager | null;
  readonly storage: ClientStorage | null;
  readonly userId: string;
  readonly scope: string;
  readonly id: string;
  readonly eligible: () => boolean;
  readonly focused: () => boolean;
  readonly show: () => boolean;
}): Promise<boolean> => {
  if (locks === null || storage === null)
    return (storage === null || isClaimedBy(storage, userId)) && focused() && eligible() && show();
  return await locks
    .request(scope, async (): Promise<boolean> => {
      if (!isClaimedBy(storage, userId) || !eligible()) return false;
      const held = (await locks.query()).held ?? [];
      if (!focused() && held.some((lock) => lock.name === `${scope}:focus`)) return false;
      try {
        const key = `purlay.push.claims.${scope}`;
        const text = storage.getItem(key);
        let parsed: unknown = null;
        if (text !== null && text.length <= 25000) {
          try {
            parsed = JSON.parse(text);
          } catch {
            /* A damaged claim list is empty, never content. */
          }
        }
        const ids = Array.isArray(parsed)
          ? parsed
              .filter(
                (value: unknown): value is string =>
                  typeof value === 'string' && value.length <= 200,
              )
              .slice(-100)
          : [];
        if (ids.includes(id) || !isClaimedBy(storage, userId) || !eligible()) return false;
        storage.setItem(key, JSON.stringify([...ids, id].slice(-100)));
        return show();
      } catch {
        noteStorageFailure('alert-claim');
        return false;
      }
    })
    .catch((): boolean => {
      noteStorageFailure('alert-lock');
      return false;
    });
};
