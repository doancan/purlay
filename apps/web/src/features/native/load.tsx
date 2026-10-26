/**
 * The door to the native consent's chunk: a person sees it once, when they set the application up, so none
 * of it is in the page everybody loads (D-49, the budget).
 */
import { lazy, Suspense } from 'react';
import { useI18n } from '../../i18n/i18n-provider';
import { Main } from '../../ui/main';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';

const Screen = lazy(async () => ({
  default: (await import('./native-sign-in-screen')).NativeSignInScreen,
}));

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

export const LazyNativeSignInScreen = (): React.JSX.Element => (
  <Suspense fallback={<Waiting />}>
    <Screen />
  </Suspense>
);
