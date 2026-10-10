/**
 * Which screen an address means.
 *
 * One switch over the route table, so adding a route is a compile error until it
 * has a screen: `Match['name']` is exhaustive here, and `default` is not written.
 * The screens for the known routes are placeholders today — the frame around them
 * is final, the screens arrive with the backend they need (D-98).
 *
 * **The gallery is a development tool and is not in the production build.** It is
 * a lazy chunk behind a condition Vite resolves *statically* (`import.meta.env.DEV`
 * is replaced by a literal, as is `VITE_GALLERY`), so when both are off the
 * dynamic `import()` is dead code and the bundler never emits the chunk — the
 * budget (#140) does not pay for a catalogue page. `VITE_GALLERY=1` builds it in,
 * which is how the browser tests photograph it from a production-shaped build.
 * It is a prop so a test can mount it without a build flag.
 */
import { lazy, Suspense, type ComponentType } from 'react';
import { useI18n } from '../i18n/i18n-provider';
import { Link, useRoute } from '../router/router-provider';
import { buttonStyle } from '../ui/button';
import { Skeleton, LoadingStatus } from '../ui/skeleton';
import { EmptyState } from '../ui/states';

const defaultGallery: ComponentType | null =
  import.meta.env.DEV || import.meta.env['VITE_GALLERY'] === '1'
    ? lazy(() => import('../gallery/gallery').then((module) => ({ default: module.Gallery })))
    : null;

const Placeholder = (): React.JSX.Element => {
  const { t } = useI18n();
  return <EmptyState as="h1" title={t('app.placeholder.title')} body={t('app.placeholder.body')} />;
};

const NotFound = (): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <EmptyState
      as="h1"
      title={t('app.notFound.title')}
      body={t('app.notFound.body')}
      action={
        <Link to="home" className={buttonStyle('primary')}>
          {t('app.notFound.home')}
        </Link>
      }
    />
  );
};

const Loading = (): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <LoadingStatus label={t('common.loading')} className="flex flex-col gap-3 p-4">
      <Skeleton className="w-sidebar" />
      <Skeleton />
      <Skeleton />
    </LoadingStatus>
  );
};

interface OutletProps {
  /** The gallery screen; absent in a production build. */
  readonly gallery?: ComponentType | null;
}

export const Outlet = ({ gallery = defaultGallery }: OutletProps): React.JSX.Element => {
  const { match } = useRoute();
  switch (match.name) {
    case 'signIn':
    case 'home':
    case 'workspace':
    case 'channel':
    case 'questions':
      return <Placeholder />;
    case 'gallery': {
      const Gallery = gallery;
      return Gallery === null ? (
        <NotFound />
      ) : (
        <Suspense fallback={<Loading />}>
          <Gallery />
        </Suspense>
      );
    }
    case 'notFound':
      return <NotFound />;
  }
};
