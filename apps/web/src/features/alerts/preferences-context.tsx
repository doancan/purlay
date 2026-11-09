import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { AlertPreferences } from '@purlay/types';
import { isClaimedBy, noteStorageFailure } from '../../data/browser-storage';
import { useClientStorage } from '../../data/storage-provider';
import { DEFAULT_ALERT_PREFERENCES, parseAlertPreferences } from './preferences';
import { browserChime, type Chime } from './chime';

/** Native audio boundary for tests; undefined uses this browser, null has no audio. */
export const ChimeContext = createContext<Chime | null | undefined>(undefined);

interface Choices {
  readonly preferences: AlertPreferences;
  readonly remembered: boolean;
  readonly change: (patch: Partial<AlertPreferences>) => void;
  readonly audio: 'locked' | 'ready' | 'failed' | 'unavailable';
  readonly preview: () => void;
  readonly play: () => boolean;
}
const Context = createContext<Choices>({
  preferences: DEFAULT_ALERT_PREFERENCES,
  remembered: false,
  change: () => undefined,
  audio: 'unavailable',
  preview: () => undefined,
  play: () => false,
});

export const AlertPreferencesProvider = ({
  userId,
  children,
}: {
  readonly userId: string;
  readonly children: React.ReactNode;
}): React.JSX.Element => {
  const storage = useClientStorage();
  const key = `purlay.push.preferences.${userId}`;
  const read = useCallback((): AlertPreferences => {
    try {
      return isClaimedBy(storage, userId)
        ? parseAlertPreferences(storage?.getItem(key) ?? null)
        : DEFAULT_ALERT_PREFERENCES;
    } catch {
      noteStorageFailure('alert-read');
      return DEFAULT_ALERT_PREFERENCES;
    }
  }, [storage, key, userId]);
  const [preferences, setPreferences] = useState(read);
  const [remembered, setRemembered] = useState(storage !== null);
  const port = useContext(ChimeContext);
  const [chime] = useState(() => (port === undefined ? browserChime() : port));
  const owned = useCallback(
    (): boolean => storage === null || isClaimedBy(storage, userId),
    [storage, userId],
  );
  const [audio, setAudio] = useState<Choices['audio']>(chime === null ? 'unavailable' : 'locked');
  useEffect(() => (): void => chime?.dispose(), [chime]);
  useEffect(() => {
    if (!preferences.sound) {
      chime?.stop();
      return;
    }
    let live = true;
    const unlock = (): void => {
      void chime?.unlock().then((ready) => {
        if (live) setAudio(ready ? 'ready' : 'locked');
      });
    };
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
    return (): void => {
      live = false;
      window.removeEventListener('pointerdown', unlock, { capture: true });
      window.removeEventListener('keydown', unlock, { capture: true });
    };
  }, [chime, preferences.sound]);
  const preview = useCallback((): void => {
    if (!owned()) return;
    void chime?.unlock().then((ready) => {
      setAudio(ready && owned() && chime.play(preferences.volume) ? 'ready' : 'failed');
    });
  }, [chime, preferences.volume, owned]);
  const play = useCallback(
    (): boolean => owned() && preferences.sound && (chime?.play(preferences.volume) ?? false),
    [chime, preferences, owned],
  );
  useEffect(() => {
    const changed = (event: StorageEvent): void => {
      if (!owned()) chime?.stop();
      if (event.key === key || event.key === null || event.key === 'purlay.person')
        setPreferences(read());
    };
    window.addEventListener('storage', changed);
    return (): void => {
      window.removeEventListener('storage', changed);
    };
  }, [read, key, owned, chime]);
  const change = useCallback(
    (patch: Partial<AlertPreferences>): void => {
      const next = { ...preferences, ...patch };
      setPreferences(next);
      try {
        if (storage === null || !isClaimedBy(storage, userId)) {
          setRemembered(false);
          return;
        }
        storage.setItem(key, JSON.stringify(next));
        setRemembered(true);
      } catch {
        setRemembered(false);
        noteStorageFailure('alert-write');
      }
    },
    [preferences, storage, userId, key],
  );
  const value = useMemo(
    () => ({ preferences, remembered, change, audio, preview, play }),
    [preferences, remembered, change, audio, preview, play],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
};

export const useAlertPreferences = (): Choices => useContext(Context);
