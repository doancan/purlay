/**
 * The door to the deferred chunk (`app/deferred.ts`) for the overlays that live in it: the command
 * palette, the shortcut reference and the sidebar's dialogs (D-163).
 *
 * **Nothing visibly waits for it.** The shell asks for the chunk once the first screen is drawn and
 * the browser is idle (`usePreloadDeferred`), so by the time anybody reaches for ⌘K or "New channel"
 * it has arrived; an overlay asked for before then is drawn the moment the chunk lands, without
 * being asked for twice.
 *
 * **Before it arrives an overlay is not mounted, and after it arrives it stays mounted**, open or
 * closed, exactly as it was when it was in the first chunk: a closed Radix dialog draws nothing, and
 * one that stays mounted keeps its closing animation and its own state.
 *
 * A chunk that does not arrive says so in a toast and the overlay stays closed; the next request
 * asks for it again rather than remembering the failure.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useI18n } from '../i18n/i18n-provider';
import { useToast } from '../ui/toast';
import type * as Deferred from './deferred';

let arrived: typeof Deferred | null = null;
let loading: Promise<typeof Deferred> | null = null;
const listeners = new Set<() => void>();

/** The chunk, asked for once; a failure is forgotten so the next request tries again. */
export const loadDeferred = (): Promise<typeof Deferred> => {
  loading ??= import('./deferred').then(
    (module) => {
      arrived = module;
      for (const listener of listeners) listener();
      return module;
    },
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
};

const snapshot = (): typeof Deferred | null => arrived;

/** An overlay behind the door: whether it is asked to be open, and how to close it again. */
export type Door = readonly [open: boolean, setOpen: (open: boolean) => void];

/**
 * The deferred chunk once it has arrived, or `null` before. It is asked for whenever one of `doors`
 * is open; if it does not come, a toast says so and every door is closed again, so a second request
 * is a second attempt. The doors' own setters, so nothing new is written at a door to close it.
 */
export const useDeferred = (...doors: readonly Door[]): typeof Deferred | null => {
  const { t } = useI18n();
  const { show } = useToast();
  const module = useSyncExternalStore(subscribe, snapshot, snapshot);
  const wanted = doors.some(([open]) => open);
  // The latest setters, without asking again every time the caller draws new ones.
  const latest = useRef(doors);
  latest.current = doors;

  useEffect(() => {
    if (!wanted || module !== null) return;
    let current = true;
    loadDeferred().catch(() => {
      if (!current) return;
      show({ message: t('deferred.unavailable') });
      for (const [, setOpen] of latest.current) setOpen(false);
    });
    return (): void => {
      current = false;
    };
  }, [wanted, module, show, t]);

  return module;
};

/** How long the browser may stay busy before the chunk is asked for anyway. */
const IDLE_TIMEOUT_MS = 2_000;

/**
 * Asks for the chunk once the first screen has been drawn and the browser has nothing better to do.
 * `requestIdleCallback` where there is one; Safari has none, and there it is the next task after the
 * timeout. A preload that fails says nothing: the request that needs the chunk asks again and says so.
 */
export const usePreloadDeferred = (): void => {
  useEffect(() => {
    const preload = (): void => {
      loadDeferred().catch(() => undefined);
    };
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(preload, { timeout: IDLE_TIMEOUT_MS });
      return (): void => {
        window.cancelIdleCallback(handle);
      };
    }
    const handle = window.setTimeout(preload, IDLE_TIMEOUT_MS);
    return (): void => {
      window.clearTimeout(handle);
    };
  }, []);
};
