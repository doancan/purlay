/** The legacy workspace address hands over to the independent server console (D-277). */
import { useQuery } from '@tanstack/react-query';
import type { ServerSettingsAnswer } from '@purlay/types';
import { useI18n } from '../../../i18n/i18n-provider';
import { LoadingStatus, Skeleton } from '../../../ui/skeleton';
import { EmptyState, ErrorState } from '../../../ui/states';
import { isSetupFailure } from '../../setup/client';
import { SERVER_SETTINGS_KEY, useServerClient } from '../server-context';

export { LegacyServerRedirect as ServerPage } from '../../administration/legacy';

/** One read lifecycle for the categorized provider/policy cards, including stale-refresh failures. */
export const ServerSettingsState = ({
  children,
}: {
  readonly children: (view: ServerSettingsAnswer) => React.ReactNode;
}): React.JSX.Element => {
  const { t } = useI18n();
  const client = useServerClient();
  const settings = useQuery({
    queryKey: SERVER_SETTINGS_KEY,
    queryFn: async ({ signal }) => await client.settings(signal),
    retry: false,
  });
  if (settings.isError && isSetupFailure(settings.error) && settings.error.status === 404)
    return <EmptyState title={t('app.notFound.title')} body={t('app.notFound.body')} />;
  if (settings.isPending)
    return (
      <LoadingStatus label={t('common.loading')} className="flex flex-col gap-4">
        <Skeleton />
        <Skeleton />
        <Skeleton />
      </LoadingStatus>
    );
  if (settings.data === undefined)
    return (
      <ErrorState
        title={t('settings.server.loadError.title')}
        body={t('settings.server.loadError.body')}
        retryLabel={t('common.retry')}
        onRetry={() => {
          void settings.refetch();
        }}
      />
    );
  return (
    <>
      {settings.isError && (
        <ErrorState
          title={t('settings.server.loadError.title')}
          body={t('settings.server.refreshError.body')}
          retryLabel={t('common.retry')}
          onRetry={() => {
            void settings.refetch();
          }}
        />
      )}
      {children(settings.data)}
    </>
  );
};
