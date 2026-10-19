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
import { useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../data/api-provider';
import { useChannels } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { useRoute } from '../../router/router-provider';
import { useNotices } from '../push/push';
import { useSession } from '../session/session';
import { useDeepWork } from '../shell/deep-work';
import { waitingCount } from '../shell/tab-title';
import { useWorkspace } from '../shell/workspace';
import { paintIcons } from './icon-badge';
import { badgeOf, isAway, planOf, risen, settled, tagOf, waitingOf, type Waiting } from './decide';

export const BackgroundAlerts = (): null => {
  const notices = useNotices();
  const quiet = useDeepWork().until !== null;
  const { workspace } = useWorkspace();
  const { user } = useSession();
  const channels = useChannels(workspace.id).data;
  const client = useQueryClient();
  const api = useApi();
  const { t } = useI18n();
  const { navigate } = useRoute();
  // What the badges said when last looked at, in this workspace: the first look is not news.
  const seen = useRef<{ readonly workspaceId: string; readonly waiting: Waiting } | null>(null);

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
    const waiting = waitingOf(channels);
    const before = seen.current?.workspaceId === workspace.id ? seen.current.waiting : null;
    seen.current = { workspaceId: workspace.id, waiting };
    if (before === null) return;
    // Read here or on another device: a notice still on screen no longer says something true.
    for (const id of settled(before, waiting)) notices?.close(tagOf(id));
    const plan = planOf(risen(before, waiting), {
      on: notices !== null,
      quiet,
      away: isAway(document),
    });
    if (plan.kind === 'none' || notices === null) return;
    void import('./tell').then(({ tell }) =>
      tell({
        plan,
        client,
        api,
        workspace,
        me: user.id,
        channels,
        t,
        notices,
        open: navigate,
      }),
    );
  }, [channels, workspace, notices, quiet, client, api, t, navigate, user.id]);

  return null;
};
