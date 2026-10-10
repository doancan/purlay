/** A channel. A stand-in the feed slice replaces: the channel's name, or why there is none. */
import { useChannels } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { EmptyState } from '../../ui/states';
import { useWorkspace } from '../shell/workspace';

export const ChannelScreen = ({ channelId }: { readonly channelId: string }): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const channels = useChannels(workspace.id);
  const channel = channels.data?.find((c) => c.id === channelId);
  if (channels.isPending) {
    return (
      <LoadingStatus label={t('common.loading')} className="p-4">
        <Skeleton />
      </LoadingStatus>
    );
  }
  if (channel === undefined) {
    return (
      <EmptyState
        as="h1"
        title={t('state.channel.missing.title')}
        body={t('state.channel.missing.body')}
      />
    );
  }
  return <h1 className="p-4 text-title text-ink">{channel.name}</h1>;
};
