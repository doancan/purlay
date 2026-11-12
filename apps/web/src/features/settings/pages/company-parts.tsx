/** Company setup uses the existing settings, clipboard and feedback primitives. */
import { useEffect, useRef } from 'react';
import { useI18n } from '../../../i18n/i18n-provider';
import { Button } from '../../../ui/button';
import { useToast } from '../../../ui/toast';
import { LoadingStatus, Skeleton } from '../../../ui/skeleton';
import { useContentPorts } from '../../content/content-ports';
import { useSession } from '../../session/session';
import { leave } from '../../sign-in/leave';
import { href } from '../../../router/routes';
import { SettingsCard } from '../page';

export type CompanyTask = (name: string, work: () => Promise<unknown>) => Promise<boolean>;

export const useCompanyAlive = (): React.RefObject<boolean> => {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return (): void => {
      alive.current = false;
    };
  }, []);
  return alive;
};

export const CompanyLoading = ({
  failed,
  retry,
}: {
  readonly failed: boolean;
  readonly retry: () => void;
}): React.JSX.Element => {
  const { t } = useI18n();
  return failed ? (
    <div className="flex items-center gap-3 px-6 py-5 max-narrow:px-4">
      <p role="alert" className="min-w-0 flex-1 text-body text-ink-muted">
        {t('company.loadFailed')}
      </p>
      <Button onClick={retry}>{t('common.retry')}</Button>
    </div>
  ) : (
    <LoadingStatus
      label={t('common.loading')}
      className="flex flex-col gap-3 px-6 py-5 max-narrow:px-4"
    >
      <Skeleton />
      <Skeleton />
    </LoadingStatus>
  );
};

export const CompanyCopyValue = ({
  label,
  value,
}: {
  readonly label: string;
  readonly value: string;
}): React.JSX.Element => {
  const { t } = useI18n();
  const { copy } = useContentPorts();
  const { show } = useToast();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="text-label text-ink">{label}</span>
      <div className="flex min-w-0 items-start gap-2">
        <code className="min-w-0 flex-1 select-all break-all rounded-md border-hairline border-border-subtle bg-surface-050 px-3 py-2 font-mono text-caption text-ink">
          {value}
        </code>
        <Button
          glyph="copy"
          aria-label={t('company.copyNamed', { label })}
          onClick={() => {
            copy(value).then(
              () => {
                show({ message: t('common.copied') });
              },
              () => {
                show({ message: t('failure.copy') });
              },
            );
          }}
        >
          {t('common.copy')}
        </Button>
      </div>
    </div>
  );
};

export const CompanySessionNotice = (): React.JSX.Element | null => {
  const { companyWorkspaceId } = useSession();
  if (companyWorkspaceId === undefined) return null;
  return <IndependentSignInNotice />;
};

export const IndependentSignInNotice = (): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <SettingsCard title={t('company.session.title')} description={t('company.session.description')}>
      <div className="px-6 py-4 max-narrow:px-4">
        <Button
          onClick={() => {
            leave.to(`${href('signIn')}?independent=1`);
          }}
        >
          {t('company.session.signIn')}
        </Button>
      </div>
    </SettingsCard>
  );
};
