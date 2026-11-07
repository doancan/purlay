/** Personal sections retain the same disclosure, row and global filtering rules as Channels. */
import { useRef, useState } from 'react';
import type { Channel, ChannelGroup } from '@purlay/types';
import { useDeferred } from '../../../app/deferred-door';
import { useChannels } from '../../../data/queries';
import { useDescribeFailure } from '../../../data/failure';
import { useI18n } from '../../../i18n/i18n-provider';
import { joinedChannels } from '../../../lib/channel-lists';
import { useRoute } from '../../../router/router-provider';
import { IconButton } from '../../../ui/icon-button';
import { Menu, MenuItem } from '../../../ui/menu';
import { useToast } from '../../../ui/toast';
import { useWorkspace } from '../../shell/workspace';
import { ChannelRow } from './channel-row';
import { useChannelGroups } from './groups-data';
import { useGroupActions } from './group-actions';
import { rowOf, shownRows } from './preferences';
import { useSidebarPreferences } from './preferences-context';
import { SectionHeading } from './section-heading';
import { SectionError, SectionLoading } from './section-state';

const GroupSection = ({
  group,
  channels,
  edit,
  remove,
}: {
  readonly group: ChannelGroup;
  readonly channels: readonly Channel[];
  readonly edit: () => void;
  readonly remove: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const describe = useDescribeFailure();
  const { show } = useToast();
  const { workspace } = useWorkspace();
  const { preferences } = useSidebarPreferences();
  const { match } = useRoute();
  const currentId = match.name === 'channel' ? match.params.channelId : null;
  const { fold } = useGroupActions();
  const opening = useRef(false);
  const mine = joinedChannels(channels, preferences.channelOrder).filter(
    (channel) => channel.sidebarGroupId === group.id,
  );
  const shown = shownRows(
    mine.map((channel) => ({ ...rowOf(channel), channel })),
    {
      collapsed: group.collapsed,
      unreadOnly: preferences.unreadOnly,
      hideMuted: preferences.hideMuted,
      currentId,
    },
  );
  return (
    <nav
      aria-label={t('channelGroups.section', { name: group.name })}
      data-channel-group={group.id}
      className="flex flex-col"
    >
      <SectionHeading
        controls={`sidebar-group-${group.id}`}
        wrap
        collapsed={group.collapsed}
        onToggle={() => {
          void fold(group).catch((failure: unknown) =>
            show({ message: `${t('channelGroups.failed')} ${describe(failure)}` }),
          );
        }}
        actions={
          <Menu
            align="end"
            returnFocus={() => !opening.current}
            onOpenChange={(open) => {
              if (open) opening.current = false;
            }}
            trigger={
              <IconButton
                glyph="more"
                label={t('channelGroups.manage', { name: group.name })}
                size="nav"
              />
            }
          >
            <MenuItem
              onSelect={() => {
                opening.current = true;
                edit();
              }}
            >
              {t('channelGroups.rename')}
            </MenuItem>
            <MenuItem
              onSelect={() => {
                opening.current = true;
                remove();
              }}
            >
              {t('channelGroups.delete')}
            </MenuItem>
          </Menu>
        }
      >
        {group.name}
      </SectionHeading>
      <div id={`sidebar-group-${group.id}`}>
        <ul className="flex flex-col gap-1">
          {shown.map(({ channel }) => (
            <li key={channel.id}>
              <ChannelRow
                slug={workspace.slug}
                channel={channel}
                glyph={channel.type === 'private' ? 'private-channel' : 'channel'}
                current={channel.id === currentId}
                unread={(channel.state?.unreadCount ?? 0) > 0}
                mentions={channel.state?.unreadMentionCount ?? 0}
                incident={channel.incident}
                muted={channel.notificationLevel === 'none'}
              >
                {channel.name}
              </ChannelRow>
            </li>
          ))}
        </ul>
        {mine.length === 0 && !group.collapsed && (
          <p className="px-2 py-1 text-caption text-nav-ink-muted">{t('channelGroups.empty')}</p>
        )}
      </div>
    </nav>
  );
};

export const PersonalGroups = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const channels = useChannels(workspace.id);
  const groups = useChannelGroups();
  const root = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<ChannelGroup | null>(null);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deferred = useDeferred([editing, setEditing], [deleting, setDeleting]);
  return (
    <div ref={root} className="contents">
      {groups.isPending && <SectionLoading label={t('channelGroups.loading')} />}
      {groups.isError && (
        <SectionError
          title={t('channelGroups.loadFailed')}
          body={t('channelGroups.loadFailedBody')}
          retryLabel={t('common.retry')}
          onRetry={() => {
            void groups.refetch();
          }}
        />
      )}
      {channels.data !== undefined &&
        [...(groups.data?.data ?? [])]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((group) => (
            <GroupSection
              key={group.id}
              group={group}
              channels={channels.data}
              edit={() => {
                setSelected(group);
                setEditing(true);
              }}
              remove={() => {
                setSelected(group);
                setDeleting(true);
              }}
            />
          ))}
      {deferred !== null && selected !== null && (
        <>
          {editing && (
            <deferred.ChannelGroupEditor
              key={selected.id}
              group={selected}
              open={editing}
              onOpenChange={setEditing}
              returnFocus={() =>
                root.current?.querySelector<HTMLButtonElement>(
                  `[data-channel-group="${selected.id}"] button[aria-haspopup="menu"]`,
                ) ??
                root.current
                  ?.closest('aside')
                  ?.querySelector<HTMLButtonElement>('[data-sidebar-options]') ??
                null
              }
            />
          )}
          {deleting && (
            <deferred.DeleteChannelGroupDialog
              key={`delete-${selected.id}`}
              group={selected}
              open={deleting}
              onOpenChange={setDeleting}
              returnFocus={() =>
                root.current?.querySelector<HTMLButtonElement>(
                  `[data-channel-group="${selected.id}"] button[aria-haspopup="menu"]`,
                ) ??
                root.current
                  ?.closest('aside')
                  ?.querySelector<HTMLButtonElement>('[data-sidebar-options]') ??
                null
              }
            />
          )}
        </>
      )}
    </div>
  );
};
