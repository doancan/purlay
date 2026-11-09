/**
 * What an open tab says while its person is somewhere else (D-148, `UX.md` §2): a notice from the
 * browser when a conversation's mention badge goes up, and a dot on the tab's icon — and an installed
 * app's badge — while anything needs them.
 *
 * Both read the badges the socket keeps current, so they say what the sidebar, the inbox dot and the
 * title say, and nothing in Deep Work. The notice needs the person's "notifications on this device"
 * (`push.tsx`), the one switch that also covers a closed tab where the server can push; this never
 * asks the browser for permission itself.
 *
 * What tells is loaded the first time there is something to tell, so a page nobody leaves never
 * carries it.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useLocks } from '../../data/locks';
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../data/api-provider';
import { useChannels } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { useRoute } from '../../router/router-provider';
import { useNotices } from '../push/push';
import type { Notice } from '../push/notifier';
import { useToast } from '../../ui/toast';
import { useClientStorage } from '../../data/storage-provider';
import { useAlertPreferences } from './preferences-context';
import { claimAlert, holdFocus } from './coordination';
import { useSession } from '../session/session';
import { useDeepWork } from '../shell/deep-work';
import { useQuietHoursNow } from '../shell/quiet-hours';
import { waitingCount } from '../shell/tab-title';
import { useWorkspace } from '../shell/workspace';
import { paintIcons } from './icon-badge';
import {
  badgeOf,
  isAway,
  planOf,
  risen,
  settled,
  summaryTag,
  tagOf,
  waitingOf,
  type Waiting,
} from './decide';

export const BackgroundAlerts = (): null => {
  const notices = useNotices();
  const { preferences, play } = useAlertPreferences();
  const { show, dismiss } = useToast();
  const storage = useClientStorage();
  const locks = useLocks();
  const cards = useRef(new Map<string, number>());
  const shown = useRef(new Set<string>());
  // Deep Work started by hand, or the person's quiet hours (D-234): the page is quiet in either.
  const quietHours = useQuietHoursNow();
  const quiet = useDeepWork().until !== null || quietHours;
  const { workspace } = useWorkspace();
  const { user } = useSession();
  const channels = useChannels(workspace.id).data;
  const permitted = useMemo(
    () =>
      new Set(
        (channels ?? [])
          .filter((channel) => channel.state !== null && channel.notificationLevel !== 'none')
          .map((channel) => channel.id),
      ),
    [channels],
  );
  const latestAllowed = useRef(permitted);
  latestAllowed.current = permitted;
  const client = useQueryClient();
  const api = useApi();
  const { t } = useI18n();
  const { navigate, match } = useRoute();
  const currentChannel = match.name === 'channel' ? match.params.channelId : null;
  const scope = `purlay.alert:${user.id}:${workspace.id}`;
  useEffect(() => {
    if (locks === null) return;
    let release: (() => void) | undefined;
    const focus = (): void => {
      release?.();
      release = isAway(document) ? undefined : holdFocus(locks, scope);
    };
    window.addEventListener('focus', focus);
    window.addEventListener('blur', focus);
    document.addEventListener('visibilitychange', focus);
    focus();
    return (): void => {
      release?.();
      window.removeEventListener('focus', focus);
      window.removeEventListener('blur', focus);
      document.removeEventListener('visibilitychange', focus);
    };
  }, [locks, scope]);
  // What the badges said when last looked at, in this workspace: the first look is not news.
  const seen = useRef<{ readonly workspaceId: string; readonly waiting: Waiting } | null>(null);
  // An inbox request may outlive this device's opt-in, Deep Work or the shell itself.
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    return (): void => {
      generation.current += 1;
      for (const id of cards.current.values()) dismiss(id);
      cards.current.clear();
      for (const tag of shown.current) notices?.close(tag);
      shown.current.clear();
    };
  }, [workspace.id, user.id, notices, quiet, preferences, currentChannel, dismiss]);

  const count = badgeOf(waitingCount(channels ?? []), quiet);
  const painted = useRef(0);
  useEffect(() => {
    if (count === painted.current) return;
    painted.current = count;
    paintIcons(count);
  }, [count]);
  // Leaving the shell — signed out, another workspace's page — takes the dot with it.
  useEffect(
    () => (): void => {
      if (painted.current === 0) return;
      painted.current = 0;
      paintIcons(0);
    },
    [],
  );

  useEffect(() => {
    if (channels === undefined) return;
    const allowed = (id: string): boolean => latestAllowed.current.has(id);
    const waiting = waitingOf(channels);
    const before = seen.current?.workspaceId === workspace.id ? seen.current.waiting : null;
    seen.current = { workspaceId: workspace.id, waiting };
    if (before === null) return;
    // Read here or on another device: a notice still on screen no longer says something true.
    for (const id of new Set([
      ...settled(before, waiting),
      ...[...before.keys()].filter((id) => !allowed(id)),
    ])) {
      if (shown.current.delete(tagOf(id))) notices?.close(tagOf(id));
      const card = cards.current.get(tagOf(id));
      if (card !== undefined) dismiss(card);
      cards.current.delete(tagOf(id));
    }
    if ([...waiting].every(([id, count]) => count === 0 || !allowed(id))) {
      if (shown.current.delete(summaryTag(workspace.id))) notices?.close(summaryTag(workspace.id));
      const summary = cards.current.get(summaryTag(workspace.id));
      if (summary !== undefined) dismiss(summary);
      cards.current.delete(summaryTag(workspace.id));
    }
    const rose = risen(before, waiting).filter(
      (id) => allowed(id) && (isAway(document) || id !== currentChannel),
    );
    if (
      quiet ||
      rose.length === 0 ||
      (notices === null && !preferences.inApp && !preferences.sound)
    )
      return;
    const version = generation.current;
    void import('./tell').then(({ tell }) => {
      const pending = rose.filter((id) => allowed(id) && (seen.current?.waiting.get(id) ?? 0) > 0);
      const current = planOf(pending, {
        on: version === generation.current,
        quiet,
        away: true,
      });
      if (current.kind === 'none') return;
      return tell({
        plan: current,
        client,
        api,
        workspace,
        me: user.id,
        channels,
        t,
        notices: {
          show: (notice: Notice): boolean => {
            const eligible = (): boolean =>
              version === generation.current &&
              pending.some((id) => allowed(id) && (seen.current?.waiting.get(id) ?? 0) > 0) &&
              (isAway(document) || pending.some((id) => id !== currentChannel));
            void claimAlert({
              locks,
              storage,
              userId: user.id,
              scope,
              id: notice.eventId ?? notice.tag,
              focused: () => !isAway(document),
              eligible,
              show: (): boolean => {
                if (!eligible()) return false;
                if (isAway(document) && notices !== null) {
                  const accepted = notices.show({ ...notice, silent: !preferences.sound });
                  if (accepted) shown.current.add(notice.tag);
                  return accepted;
                }
                let told = false;
                if (!isAway(document) && preferences.inApp) {
                  const id = show({
                    title: notice.title,
                    message: notice.body,
                    tag: notice.tag,
                    actionLabel: t('alerts.open'),
                    onAction: notice.onOpen,
                  });
                  cards.current.set(notice.tag, id);
                  for (const [tag, old] of [...cards.current].slice(0, -3)) {
                    dismiss(old);
                    cards.current.delete(tag);
                  }
                  told = true;
                }
                return play() || told;
              },
            });
            return true;
          },
        },
        open: navigate,
      });
    });
  }, [
    channels,
    workspace,
    notices,
    quiet,
    client,
    api,
    t,
    navigate,
    user.id,
    preferences,
    play,
    show,
    dismiss,
    currentChannel,
    locks,
    storage,
    scope,
  ]);

  return null;
};
