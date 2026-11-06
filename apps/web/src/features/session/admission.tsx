import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { OwnAdmission } from '@purlay/types';
import { useApi } from '../../data/api-provider';
import { useI18n } from '../../i18n/i18n-provider';
import { Button } from '../../ui/button';
import { Main } from '../../ui/main';
import { useRoute } from '../../router/router-provider';
import { href } from '../../router/routes';
import { LogoMark } from '../shell/notice';

export const useOwnAdmission = (enabled: boolean): ReturnType<typeof useQuery<OwnAdmission>> => {
  const api = useApi();
  return useQuery({
    queryKey: ['own-admission'],
    queryFn: async ({ signal }) => await api.ownAdmission(signal),
    enabled,
    retry: false,
  });
};
export const InstanceIdentity = (): React.JSX.Element | null => {
  const api = useApi();
  const { t } = useI18n();
  const query = useQuery({
    queryKey: ['instance'],
    queryFn: async ({ signal }) => await api.instanceInfo(signal),
    retry: false,
  });
  if (query.data === undefined) return null;
  const info = query.data;
  return (
    <div className="flex flex-col items-center gap-2 text-center">
      {info.displayName !== 'Purlay' && (
        <p className="text-title text-ink break-words">{info.displayName}</p>
      )}
      {info.allowedEmailDomains.length > 0 && (
        <p className="text-caption text-ink-muted break-words">
          {t('admission.domains', { domains: info.allowedEmailDomains.join(', ') })}
        </p>
      )}
      {info.requireAccountApproval && (
        <p className="text-caption text-ink-muted">{t('admission.notice')}</p>
      )}
      {info.supportUrl !== null && (
        <a className="text-label text-accent-text underline" href={info.supportUrl}>
          {t('admission.support')}
        </a>
      )}
    </div>
  );
};
export const AdmissionScreen = ({
  state,
  refresh,
  refreshing,
}: {
  readonly state: 'pending' | 'denied' | 'verify-email';
  readonly refresh: () => void;
  readonly refreshing: boolean;
}): React.JSX.Element => {
  const { t } = useI18n();
  const api = useApi();
  const { navigate } = useRoute();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const leave = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await api.signOut();
      navigate(href('signIn'), { replace: true });
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Main className="flex min-h-screen items-center justify-center bg-surface-000 p-4 text-ink">
      <section className="flex w-full max-w-dialog flex-col gap-6 rounded-2xl border-hairline border-border-subtle bg-surface-100 p-8 shadow-card">
        <LogoMark />
        <h1 className="text-display">{t(`admission.${state}.title`)}</h1>
        <p className="text-body text-ink-muted">{t(`admission.${state}.body`)}</p>
        <InstanceIdentity />
        {failed && (
          <p role="alert" className="text-body text-danger-text">
            {t('admission.signOutFailed')}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button busy={refreshing} disabled={busy} onClick={refresh}>
            {t('admin.refresh')}
          </Button>
          <Button
            busy={busy}
            disabled={refreshing}
            onClick={() => {
              void leave();
            }}
          >
            {t('user.signOut')}
          </Button>
        </div>
      </section>
    </Main>
  );
};
