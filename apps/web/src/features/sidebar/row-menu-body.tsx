/**
 * A sidebar row's context menu (D-165): what can be done to a channel or a conversation without
 * opening it, and only what applies to it and the person may do.
 *
 * - **Mark as read**, while it is unread: the feed read to its newest message, as reaching the bottom
 *   of it does — so a reply waiting in a thread still waits (D-147). Painted at once, put back and said
 *   when refused.
 * - **Star** / **Unstar**, for a channel (D-132) — a conversation has no star.
 * - **The notification level** (D-107), as the header's menu offers it: the same choice, painted first.
 * - **Copy link** — the channel's own address, whole.
 * - **Channel details…** for a channel, **Conversation details…** for a group; a conversation of two
 *   has none (`UX.md` §2).
 * - **Leave channel…** for a public or a private channel, asked first; never for a conversation,
 *   whose people do not change (D-127).
 *
 * The door (`row-menu.tsx`) mounts it on first opening and keeps it, so a dialog it opened outlives
 * the menu closing. A dialog opens once the menu has given focus back to the row, so the dialog's
 * own return lands there too.
 */
import type { Channel, NotificationLevel } from '@purlay/types';
import { useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useRef, useState } from 'react';
import { useActions } from '../../data/actions-provider';
import { useApi } from '../../data/api-provider';
import { channelStateChanged } from '../../data/cache';
import { useDescribeFailure } from '../../data/failure';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import {
  AnchoredMenu,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  type MenuAnchor,
} from '../../ui/menu';
import { useToast } from '../../ui/toast';
import { useLeaveRefusal } from '../channel/leave';
import { GroupDetailsDialog } from '../conversations/group-details';
import { useWorkspace } from '../shell/workspace';
import { forgetChannel } from '../questions/last-channel';

/** The same chunk the header's name opens (D-49): fetched once, by whichever asks first. */
const ChannelDetailsDialog = lazy(async () => ({
  default: (await import('../channel/channel-details')).ChannelDetailsDialog,
}));

/** Each level its own bell, as the header draws it (UX §2), so the choices line up with the items. */
const BELLS = { all: 'notify-all', mentions: 'notifications', none: 'deep-work' } as const;

/** What a row is, for what its menu offers. */
type Kind = 'channel' | 'group' | 'direct';

const kindOf = (channel: Channel): Kind =>
  channel.type !== 'direct_message' ? 'channel' : channel.peers.length >= 2 ? 'group' : 'direct';

/** Leave is a channel's, and a member's: a conversation's people never change (D-127). */
const mayLeave = (channel: Channel): boolean =>
  kindOf(channel) === 'channel' && channel.state !== null;

/** The feed read to its newest message, painted at once and put back when refused. */
const useMarkRead = (channel: Channel): (() => void) => {
  const { t } = useI18n();
  const api = useApi();
  const { markRead } = useActions();
  const client = useQueryClient();
  const { show } = useToast();
  const describe = useDescribeFailure();
  return () => {
    const before = channel.state;
    if (before === null) return;
    channelStateChanged(client, channel.id, { ...before, unreadCount: 0, unreadMentionCount: 0 });
    // The newest root is what a read position names; the cache's feed may not be loaded, or current.
    api
      .messages(channel.id, { limit: 1 })
      .then(async (page) => {
        const newest = page.data[0];
        if (newest === undefined) channelStateChanged(client, channel.id, before);
        else await markRead(channel.id, newest.id);
      })
      .catch((failure: unknown) => {
        channelStateChanged(client, channel.id, before);
        show({ message: `${t('rowMenu.readFailed')} ${describe(failure)}` });
      });
  };
};

interface RowMenuProps {
  readonly channel: Channel;
  /** Whether the person is in it now: leaving it takes them to the workspace. */
  readonly current: boolean;
  readonly anchor: MenuAnchor | null;
  readonly onClose: () => void;
  /** Gives focus back to the row the menu opened from. */
  readonly returnFocus: () => void;
  /**
   * What the person calls it (`useChannelTitle`) and the clipboard (`useContentPorts`), handed in by
   * the door: read here, they would pull the header's and the content's modules into this chunk's
   * shared part, which the first page then pays for in glue (`app/deferred.ts`).
   */
  readonly title: string;
  readonly copy: (text: string) => Promise<void>;
  /** The star (`useStar`) and the level (`useChooseLevel`, `LEVELS`), handed in for the same reason. */
  readonly star: ((starred: boolean) => void) | null;
  readonly choose: (level: NotificationLevel) => void;
  readonly levels: readonly NotificationLevel[];
}

export const RowMenu = ({
  channel,
  current,
  anchor,
  onClose,
  returnFocus,
  title,
  copy,
  star,
  choose,
  levels,
}: RowMenuProps): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { show } = useToast();
  const markRead = useMarkRead(channel);
  const kind = kindOf(channel);
  const name = kind === 'channel' ? `#${title}` : title;
  const level = channel.notificationLevel;
  const unread = (channel.state?.unreadCount ?? 0) > 0;
  // What an item asked for once the menu has closed and the row has focus again.
  const then = useRef<(() => void) | null>(null);
  const [details, setDetailsOpen] = useState(false);
  const [detailsOpened, setDetailsOpened] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const after = (run: () => void): void => {
    then.current = run;
  };

  const copyLink = (): void => {
    const link = new URL(
      href('channel', { slug: workspace.slug, channelId: channel.id }),
      window.location.origin,
    ).href;
    copy(link).then(
      () => {
        show({ message: t('rowMenu.linkCopied') });
      },
      () => {
        show({ message: t('failure.copy') });
      },
    );
  };

  const first = [
    unread && (
      <MenuItem key="read" glyph="confirm" onSelect={markRead}>
        {t('rowMenu.markRead')}
      </MenuItem>
    ),
    // A conversation has no star (D-132): the server would refuse one, and Starred lists channels.
    kind === 'channel' && star !== null && (
      <MenuItem
        key="star"
        glyph="star"
        onSelect={() => {
          star(!channel.starred);
        }}
      >
        {t(channel.starred ? 'rowMenu.unstar' : 'rowMenu.star')}
      </MenuItem>
    ),
  ].filter((item): item is React.JSX.Element => item !== false);

  return (
    <>
      <AnchoredMenu
        anchor={anchor}
        label={t('rowMenu.label', { name })}
        onClose={onClose}
        onClosed={() => {
          returnFocus();
          const run = then.current;
          then.current = null;
          run?.();
        }}
      >
        {first}
        {level !== null && (
          <>
            {first.length > 0 && <MenuSeparator />}
            <MenuLabel>{t('level.label')}</MenuLabel>
            <MenuRadioGroup
              value={level}
              onValueChange={(value) => {
                const chosen = levels.find((each) => each === value);
                if (chosen !== undefined) choose(chosen);
              }}
            >
              {levels.map((each) => (
                <MenuRadioItem key={each} value={each} glyph={BELLS[each]}>
                  {t(`level.${each}`)}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </>
        )}
        {(first.length > 0 || level !== null) && <MenuSeparator />}
        <MenuItem glyph="invite" onSelect={copyLink}>
          {t('rowMenu.copyLink')}
        </MenuItem>
        {kind !== 'direct' && (
          <MenuItem
            glyph="info"
            onSelect={() => {
              after(() => {
                setDetailsOpened(true);
                setDetailsOpen(true);
              });
            }}
          >
            {t(kind === 'channel' ? 'rowMenu.details' : 'rowMenu.groupDetails')}
          </MenuItem>
        )}
        {mayLeave(channel) && (
          <>
            <MenuSeparator />
            <MenuItem
              glyph="sign-out"
              tone="danger"
              onSelect={() => {
                after(() => {
                  setLeaving(true);
                });
              }}
            >
              {t('rowMenu.leave')}
            </MenuItem>
          </>
        )}
      </AnchoredMenu>
      {kind === 'channel' && detailsOpened && (
        <Suspense fallback={null}>
          <ChannelDetailsDialog channel={channel} open={details} onOpenChange={setDetailsOpen} />
        </Suspense>
      )}
      {kind === 'group' && (
        <GroupDetailsDialog
          channel={channel}
          title={title}
          open={details}
          onOpenChange={setDetailsOpen}
        />
      )}
      {mayLeave(channel) && (
        <LeaveDialog channel={channel} current={current} open={leaving} onOpenChange={setLeaving} />
      )}
    </>
  );
};

/** Leave, asked first as the details' Danger zone asks; done, said in a toast. */
const LeaveDialog = ({
  channel,
  current,
  open,
  onOpenChange,
}: {
  readonly channel: Channel;
  readonly current: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const { leaveChannel } = useActions();
  const { workspace } = useWorkspace();
  const { navigate } = useRoute();
  const { show } = useToast();
  const refusal = useLeaveRefusal();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const name = channel.name ?? '';

  const leave = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await leaveChannel(channel);
      forgetChannel(workspace.id, channel.id);
      onOpenChange(false);
      show({ message: t('details.left', { name }) });
      // Only the channel being read is taken away from under the person; another stays where it is.
      if (current) navigate(href('workspace', { slug: workspace.slug }));
    } catch (failure) {
      setProblem(refusal(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setProblem(null);
        onOpenChange(next);
      }}
      title={t('rowMenu.leaveTitle', { name })}
      description={t(channel.type === 'private' ? 'rowMenu.leavePrivate' : 'rowMenu.leavePublic')}
      closeLabel={t('common.close')}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              onOpenChange(false);
              setProblem(null);
            }}
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            busy={busy}
            onClick={() => {
              void leave();
            }}
          >
            {t('details.leave')}
          </Button>
        </>
      }
    >
      {problem !== null && (
        <p role="alert" className="text-label text-danger-text">
          {problem}
        </p>
      )}
    </Dialog>
  );
};
