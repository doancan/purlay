/**
 * The door to the issues module's chunk (D-250, D-254): its screen, loaded by one `import()` the first time the
 * route is drawn, with a quiet skeleton while it comes. Nothing else imports `issues-screen` — not the shell, not
 * the deferred chunk — so a server that does not run the module never asks for it, and `budget:web` holds the
 * initial chunks to carrying none of it.
 */
import { lazy, Suspense } from 'react';
import { useI18n } from '../../i18n/i18n-provider';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';

const Screen = lazy(async () => ({ default: (await import('./issues-screen')).IssuesScreen }));

const Waiting = (): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <LoadingStatus label={t('common.loading')} className="flex w-full flex-col gap-3 p-10">
      <Skeleton />
      <Skeleton />
      <Skeleton />
    </LoadingStatus>
  );
};

export const LazyIssuesScreen = (): React.JSX.Element => (
  <Suspense fallback={<Waiting />}>
    <Screen />
  </Suspense>
);
