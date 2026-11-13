/** Both the empty account and workspace menu load the creation form only when it is shown. */
import { lazy, Suspense } from 'react';
import type { CreateWorkspaceProps } from './create-workspace';
import { useI18n } from '../../i18n/i18n-provider';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';

const Form = lazy(async () => ({ default: (await import('./create-workspace')).CreateWorkspace }));

export const LazyCreateWorkspace = (props: CreateWorkspaceProps): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <Suspense
      fallback={
        <LoadingStatus
          label={t('common.loading')}
          className="flex flex-col gap-4 border-t-hairline border-border-subtle pt-6"
        >
          <Skeleton className="h-touch" />
          <Skeleton className="h-touch" />
          <Skeleton className="h-touch w-1/3" />
        </LoadingStatus>
      }
    >
      <Form {...props} />
    </Suspense>
  );
};
