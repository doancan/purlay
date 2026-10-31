/**
 * What the composer reaches outside the page for: storage and time.
 *
 * Absent, they are the browser's. The browser's are looked up when the composer renders
 * and not when this file loads, because the build prerenders the shell with no `window`
 * (D-50), and `localStorage` may be missing or throw even where there is one.
 */
import { createContext } from 'react';
import type { Schedule } from '../../realtime/connection';
import { browserSchedule } from '../../realtime/socket';
import type { DraftStorage } from './drafts';

export interface ComposerPorts {
  /** Where drafts live; null when the page has none, and then nothing is remembered. */
  readonly storage: DraftStorage | null;
  readonly schedule: Schedule;
  /** Whether the device is only touch — no pointer that hovers — so Enter is a line break (`enterAction`). */
  readonly touchOnly?: () => boolean;
}

/**
 * A phone, or a tablet with nothing attached: the primary pointer is coarse and cannot hover. The
 * stylesheet's `touch-only:` variant is this query, so a key is hidden where Enter stops sending.
 */
export const TOUCH_ONLY_QUERY = '(pointer: coarse) and (hover: none)';

export const isTouchOnly = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia(TOUCH_ONLY_QUERY).matches;

export const ComposerPortsContext = createContext<ComposerPorts | null>(null);

/** The browser's storage, or null if reading the property itself throws (it can, when storage is blocked). */
const browserStorage = (): DraftStorage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export const browserPorts = (): ComposerPorts => ({
  storage: browserStorage(),
  schedule: browserSchedule,
  touchOnly: isTouchOnly,
});
