/**
 * The doors to the wizard's chunk: a setup page is seen once per server, by one person, so none of it
 * is in the page everybody loads (D-49, the budget). Both screens come in by one `import()`.
 */
import { lazy, Suspense } from 'react';
import { useI18n } from '../../i18n/i18n-provider';
import { Main } from '../../ui/main';
import type * as Chunk from './screens-chunk';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';

const load = (): Promise<typeof Chunk> => import('./screens-chunk');

const Setup = lazy(async () => ({ default: (await load()).SetupScreen }));
const Verify = lazy(async () => ({ default: (await load()).VerifyScreen }));

const Waiting = (): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <Main className="flex min-h-screen items-center justify-center bg-surface-000 p-4">
      <LoadingStatus
        label={t('common.loading')}
        className="flex w-full max-w-dialog flex-col gap-3"
      >
        <Skeleton />
        <Skeleton />
        <Skeleton />
      </LoadingStatus>
    </Main>
  );
};

export const LazySetupScreen = (): React.JSX.Element => (
  <Suspense fallback={<Waiting />}>
    <Setup />
  </Suspense>
);

export const LazyVerifyScreen = (): React.JSX.Element => (
  <Suspense fallback={<Waiting />}>
    <Verify />
  </Suspense>
);
