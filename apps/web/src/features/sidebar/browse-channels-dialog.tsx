/**
 * Public channels the person is not in, each one click from joined.
 *
 * Reads the same channel list the sidebar does, so a channel joined here leaves this list
 * and enters the sidebar in the same render with no second request. A join that fails says
 * so in a toast and leaves the row where it was; the person is never navigated into a
 * channel they are not in.
 */
import { useDescribeFailure } from '../../data/failure';
import { useState } from 'react';
import { Icon } from '../../components/icon';
import { useActions } from '../../data/actions-provider';
import { useChannels } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { Button } from '../../ui/button';
import { Dialog } from '../../ui/dialog';
import { useToast } from '../../ui/toast';
import { useWorkspace } from '../shell/workspace';
import { joinableChannels } from './ordering';
import { SectionEmpty, SectionError, SectionLoading } from './section-state';

export const BrowseChannelsDialog = ({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const channels = useChannels(workspace.id);
  const { joinChannel } = useActions();
  const { navigate } = useRoute();
  const { show } = useToast();
  const describe = useDescribeFailure();
  const [joining, setJoining] = useState<string | null>(null);

  const join = async (channelId: string): Promise<void> => {
    setJoining(channelId);
    try {
      await joinChannel(channelId);
      onOpenChange(false);
      navigate(href('channel', { slug: workspace.slug, channelId }));
    } catch (failure) {
      show({ message: `${t('browse.joinFailed')} ${describe(failure)}` });
    } finally {
      setJoining(null);
    }
  };

  const joinable = joinableChannels(channels.data ?? []);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('browse.title')}
      description={t('browse.description')}
      closeLabel={t('common.close')}
    >
      {channels.isPending ? (
        <SectionLoading label={t('browse.loading')} />
      ) : channels.isError ? (
        <SectionError
          title={t('browse.error.title')}
          body={t('browse.error.body')}
          retryLabel={t('common.retry')}
          onRetry={() => {
            void channels.refetch();
          }}
        />
      ) : joinable.length === 0 ? (
        <SectionEmpty title={t('browse.empty.title')} body={t('browse.empty.body')} />
      ) : (
        <ul className="flex max-h-screen flex-col gap-1 overflow-y-auto">
          {joinable.map((channel) => (
            <li key={channel.id} className="flex items-center gap-3 px-1">
              <Icon name="channel" />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-mono text-body text-ink">{channel.name}</span>
                {channel.topic === null || channel.topic === '' ? null : (
                  <span className="truncate text-caption text-ink-muted">{channel.topic}</span>
                )}
              </div>
              <Button
                busy={joining === channel.id}
                aria-label={t('browse.joinLabel', { name: channel.name ?? '' })}
                onClick={() => {
                  void join(channel.id);
                }}
              >
                {t('browse.join')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
};
