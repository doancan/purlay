/**
 * The keys that work everywhere in the signed-in application, and the two overlays
 * they open (`UX.md` §7).
 *
 * - `Cmd/Ctrl+K` — the command palette (a toggle: the same key closes it).
 * - `Cmd/Ctrl+/` — the shortcut reference.
 * - `Alt+↑` / `Alt+↓` — the previous / next channel with something unread, in the order
 *   the sidebar lists them, wrapping; nothing happens when nothing else is unread.
 * - `Shift+Esc` — every channel marked read (D-238).
 *
 * **One `keydown` listener on `document`**, which is the right place for a key that
 * must work wherever focus is. It claims only chords that carry a modifier, so there
 * is no single-letter shortcut here to collide with typing, and the composer keeps
 * its `Cmd+K` and `Alt+Arrow` like everywhere else: a person writing a message can
 * still jump to another channel. The single keys — `T`, `R`, `↑`, `↓` on a message —
 * belong to the feed and are handled where the message has focus. `Shift+Esc` has a second
 * listener of its own, on the way in rather than on the way out (below).
 *
 * It stands down for an event somebody already handled (`defaultPrevented`) and for
 * an IME composition in progress, where a key is a character being chosen. While an
 * overlay is open the channel keys do nothing: they would navigate a page the person
 * cannot see.
 *
 * `preventDefault` on the chords it takes, because the browser has meanings for them
 * (`Cmd+K` focuses the address bar in some browsers, `Alt+←` is Back).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useDeferred, usePreloadDeferred } from '../../app/deferred-door';
import { useChannels } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { VisuallyHidden } from '../../ui/visually-hidden';
import { displayName, inSidebarOrder, stepUnread } from '../palette/channels';
import { isMacPlatform, type PlatformSource } from '../shortcuts/platform';
import { useSession } from '../session/session';
import { useOverlay } from './overlay';
import { useMarkAllRead } from './read-all';
import { useWorkspace } from './workspace';

/** What holds its own Escape: a key pressed inside one is left to it. */
const TOPMOST = '[role="dialog"], [role="alertdialog"], [role="menu"]';

interface GlobalKeysProps {
  /** What to read the platform from; the browser's `navigator` when absent. */
  readonly platform?: PlatformSource;
}

export const GlobalKeys = ({ platform }: GlobalKeysProps): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { user } = useSession();
  const { match, navigate } = useRoute();
  const channels = useChannels(workspace.id).data;
  const { overlay, setOverlay } = useOverlay();
  const markAllRead = useMarkAllRead();
  const [announcement, setAnnouncement] = useState('');
  const mac = useMemo(() => isMacPlatform(platform ?? navigator), [platform]);
  // Both overlays are in the deferred chunk (D-163). A key has no pointer to preload it on, so it
  // is fetched here, once the first screen is drawn and the browser is idle.
  usePreloadDeferred();
  const palette = (open: boolean): void => {
    setOverlay(open ? 'palette' : null);
  };
  const shortcuts = (open: boolean): void => {
    setOverlay(open ? 'shortcuts' : null);
  };
  const deferred = useDeferred(
    [overlay === 'palette', palette],
    [overlay === 'shortcuts', shortcuts],
  );

  const slug = workspace.slug;
  const currentId = match.name === 'channel' ? match.params.channelId : null;

  // What the keys read, as it is now: kept in a ref so the listener is bound once, not torn down and
  // bound again each time the channel list changes — which is every message that arrives.
  const latest = useRef({ channels, currentId, overlay, markAllRead });
  useEffect(() => {
    latest.current = { channels, currentId, overlay, markAllRead };
  });

  // `Shift+Esc` is taken as the page is entered (the capture phase), before anything inside it sees the
  // key: the panels, the feed, the editor and the composer read Escape without asking about Shift, and
  // would close or leave as well. A dialog or a menu is the topmost thing, and its Escape is its own.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !event.shiftKey) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.defaultPrevented || event.isComposing || latest.current.overlay !== null) return;
      if (event.target instanceof Element && event.target.closest(TOPMOST) !== null) return;
      event.preventDefault();
      event.stopPropagation();
      // A key held down repeats: one press is one request.
      if (!event.repeat) latest.current.markAllRead();
    };
    document.addEventListener('keydown', onKeyDown, { capture: true });
    return (): void => {
      document.removeEventListener('keydown', onKeyDown, { capture: true });
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const { channels, currentId, overlay } = latest.current;
      if (event.defaultPrevented || event.isComposing) return;
      const command = event.metaKey || event.ctrlKey;

      if (command && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOverlay((now) => (now === 'palette' ? null : 'palette'));
        return;
      }
      // Settings (D-146), where the platforms put an application's preferences.
      if (command && !event.altKey && !event.shiftKey && event.key === ',') {
        event.preventDefault();
        setOverlay(null);
        navigate(href('settingsHome', { slug }));
        return;
      }
      // `/` is a shifted key on some layouts, so Shift is not held against it.
      if (command && !event.altKey && event.key === '/') {
        event.preventDefault();
        setOverlay((now) => (now === 'shortcuts' ? null : 'shortcuts'));
        return;
      }
      if (
        event.altKey &&
        !command &&
        !event.shiftKey &&
        (event.key === 'ArrowUp' || event.key === 'ArrowDown')
      ) {
        event.preventDefault();
        if (overlay !== null) return;
        const target = stepUnread(
          inSidebarOrder(channels ?? []),
          currentId,
          event.key === 'ArrowDown' ? 1 : -1,
        );
        if (target === null) return;
        navigate(href('channel', { slug, channelId: target.id }));
        setAnnouncement(
          t('palette.announce.channel', {
            name: displayName(target, user.id, t('sidebar.you'), t('user.erased')),
          }),
        );
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return (): void => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [navigate, setOverlay, slug, t, user.id]);

  return (
    <>
      {deferred !== null && (
        <>
          <deferred.CommandPalette open={overlay === 'palette'} onOpenChange={palette} />
          <deferred.ShortcutsDialog
            open={overlay === 'shortcuts'}
            mac={mac}
            onOpenChange={shortcuts}
          />
        </>
      )}
      <VisuallyHidden role="status" aria-live="polite">
        {announcement}
      </VisuallyHidden>
    </>
  );
};
