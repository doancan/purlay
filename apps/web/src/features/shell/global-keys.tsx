/**
 * The keys that work everywhere in the signed-in application, and the two overlays
 * they open (`UX.md` §7).
 *
 * - `Cmd/Ctrl+K` — the command palette (a toggle: the same key closes it).
 * - `Cmd/Ctrl+/` — the shortcut reference.
 * - `Alt+↑` / `Alt+↓` — the previous / next channel with something unread, in the order
 *   the sidebar lists them, wrapping; nothing happens when nothing else is unread.
 *
 * **One `keydown` listener on `document`**, which is the right place for a key that
 * must work wherever focus is. It claims only chords that carry a modifier, so there
 * is no single-letter shortcut here to collide with typing, and the composer keeps
 * its `Cmd+K` and `Alt+Arrow` like everywhere else: a person writing a message can
 * still jump to another channel. The single keys — `T`, `R`, `↑`, `↓` on a message —
 * belong to the feed and are handled where the message has focus.
 *
 * It stands down for an event somebody already handled (`defaultPrevented`) and for
 * an IME composition in progress, where a key is a character being chosen. While an
 * overlay is open the channel keys do nothing: they would navigate a page the person
 * cannot see.
 *
 * `preventDefault` on the chords it takes, because the browser has meanings for them
 * (`Cmd+K` focuses the address bar in some browsers, `Alt+←` is Back).
 */
import { useEffect, useMemo, useState } from 'react';
import { useChannels } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { VisuallyHidden } from '../../ui/visually-hidden';
import { displayName, inSidebarOrder, stepUnread } from '../palette/channels';
import { CommandPalette } from '../palette/command-palette';
import { isMacPlatform, type PlatformSource } from '../shortcuts/platform';
import { ShortcutsDialog } from '../shortcuts/shortcuts-dialog';
import { useSession } from '../session/session';
import { useOverlay } from './overlay';
import { useWorkspace } from './workspace';

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
  const [announcement, setAnnouncement] = useState('');
  const mac = useMemo(() => isMacPlatform(platform ?? navigator), [platform]);

  const slug = workspace.slug;
  const currentId = match.name === 'channel' ? match.params.channelId : null;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.isComposing) return;
      const command = event.metaKey || event.ctrlKey;

      if (command && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOverlay((now) => (now === 'palette' ? null : 'palette'));
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
          t('palette.announce.channel', { name: displayName(target, user.id, t('sidebar.you')) }),
        );
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return (): void => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [channels, currentId, navigate, overlay, setOverlay, slug, t, user.id]);

  return (
    <>
      <CommandPalette
        open={overlay === 'palette'}
        onOpenChange={(open) => {
          setOverlay(open ? 'palette' : null);
        }}
      />
      <ShortcutsDialog
        open={overlay === 'shortcuts'}
        mac={mac}
        onOpenChange={(open) => {
          setOverlay(open ? 'shortcuts' : null);
        }}
      />
      <VisuallyHidden role="status" aria-live="polite">
        {announcement}
      </VisuallyHidden>
    </>
  );
};
