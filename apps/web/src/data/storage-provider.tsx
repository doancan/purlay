/**
 * Hands the page's storage to whoever needs it, and lets a test hand over its own.
 *
 * The provider is given a `ClientStorage` (or `null`, a page with none) by the
 * application's providers; asked for with nothing above it, `useClientStorage` is the
 * browser's. Kept a context rather than a module-level `localStorage` read so that a test
 * can watch exactly what is stored, and so that "signing out forgets" is a thing a test
 * can ask of a fake.
 */
import { createContext, useContext, useMemo } from 'react';
import { browserStorage, type ClientStorage } from './browser-storage';

const StorageContext = createContext<{ readonly storage: ClientStorage | null } | null>(null);

export const StorageProvider = ({
  storage,
  children,
}: {
  /** `undefined`: the browser's. `null`: a page with no storage at all. */
  readonly storage?: ClientStorage | null;
  readonly children: React.ReactNode;
}): React.JSX.Element => {
  const value = useMemo(
    () => ({ storage: storage === undefined ? browserStorage() : storage }),
    [storage],
  );
  return <StorageContext.Provider value={value}>{children}</StorageContext.Provider>;
};

export const useClientStorage = (): ClientStorage | null => {
  const held = useContext(StorageContext);
  const own = useMemo(() => (held === null ? browserStorage() : null), [held]);
  return held === null ? own : held.storage;
};
