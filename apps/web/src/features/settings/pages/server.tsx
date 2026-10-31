/**
 * Settings → Server (UX §11, D-179 §4.8): how this server lets people in, for its administrator alone.
 * Five cards — GitHub sign-in, single sign-on (D-200), e-mail, who may create an account, who may create a workspace — over one
 * query that is read again after every change and never polled. Loading, a failed read with Retry, and
 * the page being gone (the server says *not found* to anybody who is not the administrator, a demotion
 * included) are each said.
 */
import { useQuery } from '@tanstack/react-query';
import { useI18n } from '../../../i18n/i18n-provider';
import { LoadingStatus, Skeleton } from '../../../ui/skeleton';
import { ErrorState } from '../../../ui/states';
import { isSetupFailure } from '../../setup/client';
import { NotFound } from '../../shell/not-found';
import { SettingsPage } from '../page';
import { SERVER_SETTINGS_KEY, useServerClient } from '../server-context';
import { EmailCard, GitHubCard } from './server-channels';
import { OidcCard } from './server-oidc';
import { AccountsCard } from './server-accounts';
import { CreatorsCard, PolicyCard } from './server-policies';

export const ServerPage = (): React.JSX.Element => {
  const { t } = useI18n();
  const client = useServerClient();
  const settings = useQuery({
    queryKey: SERVER_SETTINGS_KEY,
    queryFn: async ({ signal }) => await client.settings(signal),
    // The page has its own Retry; the server's 404 — not the administrator — is no failure to try again.
    retry: false,
  });

  if (settings.isError && isSetupFailure(settings.error) && settings.error.status === 404) {
    return <NotFound />;
  }

  return (
    <SettingsPage title={t('settings.server.title')} description={t('settings.server.description')}>
      {settings.isPending ? (
        <LoadingStatus label={t('common.loading')} className="flex flex-col gap-4">
          <Skeleton />
          <Skeleton />
          <Skeleton />
        </LoadingStatus>
      ) : settings.isError && settings.data === undefined ? (
        <ErrorState
          title={t('settings.server.loadError.title')}
          body={t('settings.server.loadError.body')}
          retryLabel={t('common.retry')}
          onRetry={() => {
            void settings.refetch();
          }}
        />
      ) : (
        <>
          <GitHubCard view={settings.data} />
          <OidcCard view={settings.data} />
          <EmailCard view={settings.data} />
          <PolicyCard view={settings.data} />
          <CreatorsCard view={settings.data} />
          <AccountsCard />
        </>
      )}
    </SettingsPage>
  );
};
