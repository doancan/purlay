/**
 * `/w/:slug` — the workspace's front door: the channel the person was last in or the
 * first they belong to, or an invitation to make one.
 */
import { useEffect } from 'react';
import { useChannels } from '../../data/queries';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { EmptyState } from '../../ui/states';
import { useWorkspace } from './workspace';

export const WorkspaceHome = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const channels = useChannels(workspace.id);
  const { navigate } = useRoute();
  const target = channels.data?.find((c) => c.state !== null);

  useEffect(() => {
    if (target !== undefined) {
      navigate(href('channel', { slug: workspace.slug, channelId: target.id }), { replace: true });
    }
  }, [target, workspace.slug, navigate]);

  if (target === undefined && channels.isSuccess) {
    return (
      <EmptyState
        as="h1"
        title={t('state.workspace.empty.title')}
        body={t('state.workspace.empty.body')}
      />
    );
  }
  return (
    <LoadingStatus label={t('common.loading')} className="flex flex-col gap-3 p-4">
      <Skeleton className="w-sidebar" />
      <Skeleton />
    </LoadingStatus>
  );
};
