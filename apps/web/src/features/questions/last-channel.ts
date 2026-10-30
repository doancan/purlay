/**
 * The channel a person was last in, per workspace: where the "Feed" tab of the
 * open-questions view takes them back to.
 *
 * Per device and per workspace, in `localStorage`, like the language and the theme — it is
 * a convenience, not data, so a browser that refuses storage (a private window, a quota)
 * simply has no last channel and the tab falls back to the first one they belong to.
 */
import { noteStorageFailure } from '../../data/browser-storage';

const keyFor = (workspaceId: string): string => `purlay.lastChannel.${workspaceId}`;

export const rememberChannel = (workspaceId: string, channelId: string): void => {
  try {
    window.localStorage.setItem(keyFor(workspaceId), channelId);
  } catch {
    // Not saved; the next visit starts from the first channel instead.
    noteStorageFailure('last-channel-write');
  }
};

export const lastChannel = (workspaceId: string): string | null => {
  try {
    return window.localStorage.getItem(keyFor(workspaceId));
  } catch {
    noteStorageFailure('last-channel-read');
    return null;
  }
};

/**
 * Forgets the channel if it is the one remembered: one the person left or archived is not where
 * the workspace's front door should send them back to.
 */
export const forgetChannel = (workspaceId: string, channelId: string): void => {
  try {
    if (window.localStorage.getItem(keyFor(workspaceId)) === channelId) {
      window.localStorage.removeItem(keyFor(workspaceId));
    }
  } catch {
    noteStorageFailure('last-channel-write');
  }
};
