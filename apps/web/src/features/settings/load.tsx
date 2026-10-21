/**
 * The doors to the settings' chunk (D-146, D-49): the screen in the main column and the navigation in
 * the sidebar's place, both loaded by one `import()` the first time either is drawn, each with a
 * quiet skeleton while it comes.
 */
import { lazy, Suspense } from 'react';
import { useI18n } from '../../i18n/i18n-provider';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import type * as Deferred from '../../app/deferred';

// The chunk it is in is shared with the image viewer (`app/deferred.ts`, D-159).
const load = (): Promise<typeof Deferred> => import('../../app/deferred');

const Screen = lazy(async () => ({ default: (await load()).SettingsScreen }));
const Nav = lazy(async () => ({ default: (await load()).SettingsNav }));

const Waiting = ({ className }: { readonly className: string }): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <LoadingStatus label={t('common.loading')} className={className}>
      <Skeleton />
      <Skeleton />
      <Skeleton />
    </LoadingStatus>
  );
};

export const LazySettingsScreen = ({
  section,
}: {
  readonly section: string;
}): React.JSX.Element => (
  <Suspense fallback={<Waiting className="flex w-full flex-col gap-3 p-10" />}>
    <Screen section={section} />
  </Suspense>
);

export const LazySettingsNav = (): React.JSX.Element => (
  <Suspense fallback={<Waiting className="flex flex-col gap-3 px-4 py-3" />}>
    <Nav />
  </Suspense>
);
