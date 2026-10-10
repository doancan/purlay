/**
 * The channel a person was last in, per workspace: where the "Feed" tab of the
 * open-questions view takes them back to.
 *
 * Per device and per workspace, in `localStorage`, like the language and the theme — it is
 * a convenience, not data, so a browser that refuses storage (a private window, a quota)
 * simply has no last channel and the tab falls back to the first one they belong to.
 */
const keyFor = (workspaceId: string): string => `purlay.lastChannel.${workspaceId}`;

export const rememberChannel = (workspaceId: string, channelId: string): void => {
  try {
    window.localStorage.setItem(keyFor(workspaceId), channelId);
  } catch {
    // Not saved; the next visit starts from the first channel instead.
  }
};

export const lastChannel = (workspaceId: string): string | null => {
  try {
    return window.localStorage.getItem(keyFor(workspaceId));
  } catch {
    return null;
  }
};
