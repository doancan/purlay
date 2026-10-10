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
}

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
});
