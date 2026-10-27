/**
 * The person's sidebar preferences for the workspace they are in (D-195), held in the page and kept in
 * the browser.
 *
 * The provider is remounted when the person or the workspace changes (`key`), so one workspace's
 * folds are never drawn in another. Read once, when it mounts, and written when something changes: a
 * page that has no storage, or refuses it, still arranges the sidebar for as long as it is open and
 * leaves one inspectable note (`noteStorageFailure`) rather than a toast — a layout that is not
 * remembered is not worth interrupting anybody for. Asked for with nothing above it, the hook gives the
 * defaults and changes nothing, so a section drawn on its own (a test, a story) needs no provider.
 */
import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { noteStorageFailure, type ClientStorage } from '../../data/browser-storage';
import { useClientStorage } from '../../data/storage-provider';
import {
  DEFAULT_PREFERENCES,
  keyFor,
  parsePreferences,
  serialisePreferences,
  type SidebarPreferences,
} from './preferences';

interface Held {
  readonly preferences: SidebarPreferences;
  readonly change: (next: Partial<SidebarPreferences>) => void;
  readonly reset: () => void;
}

const NOTHING: Held = {
  preferences: DEFAULT_PREFERENCES,
  change: () => undefined,
  reset: () => undefined,
};

const Context = createContext<Held>(NOTHING);

const readFrom = (storage: ClientStorage | null, key: string): SidebarPreferences => {
  try {
    return parsePreferences(storage?.getItem(key) ?? null);
  } catch {
    noteStorageFailure('sidebar-read');
    return DEFAULT_PREFERENCES;
  }
};

const writeTo = (storage: ClientStorage | null, key: string, next: SidebarPreferences): void => {
  try {
    storage?.setItem(key, serialisePreferences(next));
  } catch {
    noteStorageFailure('sidebar-write');
  }
};

export const SidebarPreferencesProvider = ({
  userId,
  workspaceId,
  children,
}: {
  readonly userId: string;
  readonly workspaceId: string;
  readonly children: React.ReactNode;
}): React.JSX.Element => {
  const storage = useClientStorage();
  const key = keyFor(userId, workspaceId);
  const [preferences, setPreferences] = useState(() => readFrom(storage, key));

  const apply = useCallback(
    (next: SidebarPreferences) => {
      setPreferences(next);
      writeTo(storage, key, next);
    },
    [storage, key],
  );
  const change = useCallback(
    (partial: Partial<SidebarPreferences>) => {
      apply({ ...preferences, ...partial });
    },
    [apply, preferences],
  );
  const reset = useCallback(() => {
    apply(DEFAULT_PREFERENCES);
  }, [apply]);
  const held = useMemo(() => ({ preferences, change, reset }), [preferences, change, reset]);
  return <Context.Provider value={held}>{children}</Context.Provider>;
};

export const useSidebarPreferences = (): Held => useContext(Context);
