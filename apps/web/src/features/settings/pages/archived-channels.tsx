/**
 * Archived channels (D-232), on General for an owner or an admin: what was archived, the most recent
 * first, each with a way back. A private one is listed only to somebody in it, as the server answers.
 *
 * Restored, a channel leaves this list and returns to its members' sidebars (the server tells them).
 * A name taken since it was archived is refused, and said: the other channel is renamed first.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useApi } from '../../../data/api-provider';
import { isApiError } from '../../../data/errors';
import { useDescribeFailure } from '../../../data/failure';
import { keys } from '../../../data/keys';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { LoadingStatus, Skeleton } from '../../../ui/skeleton';
import { useToast } from '../../../ui/toast';
import { useWorkspace } from '../../shell/workspace';
import { SettingsCard } from '../page';

export const ArchivedChannelsCard = (): React.JSX.Element => {
  const { t, format } = useI18n();
  const api = useApi();
  const client = useQueryClient();
  const describe = useDescribeFailure();
  const { show } = useToast();
  const { workspace } = useWorkspace();
  const [restoring, setRestoring] = useState<string | null>(null);

  const list = useQuery({
    queryKey: keys.archivedChannels(workspace.id),
    queryFn: async ({ signal }) => await api.archivedChannels(workspace.id, signal),
  });

  const restore = async (channelId: string, name: string): Promise<void> => {
    setRestoring(channelId);
    try {
      await api.restoreChannel(channelId);
      show({ message: t('settings.archived.restored', { channel: `#${name}` }) });
    } catch (failure) {
      show({
        message:
          isApiError(failure) && failure.code === 'CHANNEL_NAME_TAKEN'
            ? t('settings.archived.nameTaken', { channel: `#${name}` })
            : `${t('settings.archived.failed', { channel: `#${name}` })} ${describe(failure)}`,
      });
    } finally {
      setRestoring(null);
      await Promise.all([
        client.invalidateQueries({ queryKey: keys.archivedChannels(workspace.id) }),
        client.invalidateQueries({ queryKey: keys.channels(workspace.id) }),
      ]);
    }
  };

  return (
    <SettingsCard
      title={t('settings.archived.title')}
      description={t('settings.archived.description')}
    >
      {list.isError ? (
        <div className="flex items-center gap-3 px-6 py-5 max-narrow:px-4">
          <p className="min-w-0 flex-1 text-body text-ink-muted">
            {t('settings.archived.loadFailed')}
          </p>
          <Button
            onClick={() => {
              void list.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </div>
      ) : list.data === undefined ? (
        <LoadingStatus label={t('common.loading')} className="flex flex-col gap-3 px-6 py-5">
          <Skeleton />
          <Skeleton />
        </LoadingStatus>
      ) : list.data.length === 0 ? (
        <p className="px-6 py-5 text-body text-ink-muted max-narrow:px-4">
          {t('settings.archived.none')}
        </p>
      ) : (
        <ul className="flex flex-col">
          {list.data.map((channel) => (
            <li
              key={channel.id}
              className="flex items-center gap-4 not-first:border-t-hairline border-border-subtle px-6 py-3 max-narrow:px-4"
            >
              <span id={`archived-${channel.id}`} className="min-w-0 flex-1 text-body text-ink">
                {t(
                  channel.type === 'private'
                    ? 'settings.archived.rowPrivate'
                    : 'settings.archived.row',
                  { channel: `#${channel.name}`, when: format.absolute(channel.archivedAt) },
                )}
              </span>
              <Button
                aria-describedby={`archived-${channel.id}`}
                busy={restoring === channel.id}
                disabled={restoring !== null && restoring !== channel.id}
                onClick={() => {
                  void restore(channel.id, channel.name);
                }}
              >
                {t('settings.archived.restore')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
  );
};
