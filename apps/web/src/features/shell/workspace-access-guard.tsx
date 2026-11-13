/** A named policy refusal removes this workspace's content without ending the native account. */
import { useEffect, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { workspaceAccessRequiredKey } from '../../data/access-change';
import { useI18n } from '../../i18n/i18n-provider';
import { workspaceAccessHref } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { Main } from '../../ui/main';
import { useSession } from '../session/session';
import { useWorkspace } from './workspace';

export const WorkspaceAccessGuard = ({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element => {
  const client = useQueryClient();
  const { workspace } = useWorkspace();
  const { user } = useSession();
  const { navigate } = useRoute();
  const { t } = useI18n();
  const key = workspaceAccessRequiredKey(workspace.id, user.id);
  const blocked = useSyncExternalStore(
    (notify) =>
      client.getQueryCache().subscribe(() => {
        notify();
      }),
    () => client.getQueryData<boolean>(key) === true,
  );
  useEffect(() => {
    if (blocked) navigate(workspaceAccessHref(workspace.slug), { replace: true });
  }, [blocked, navigate, workspace.slug]);
  return blocked ? (
    <Main>
      <LoadingStatus label={t('common.loading')} className="p-6">
        <Skeleton />
      </LoadingStatus>
    </Main>
  ) : (
    <>{children}</>
  );
};
