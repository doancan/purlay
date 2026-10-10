/**
 * The application: providers, the frame, and where a screen goes.
 *
 * The frame is what is true on every screen — a skip link first, the toasts' live
 * region, and the one `<main>` each screen renders (`ui/main.tsx`), which is the target
 * of that link — and what a keyboard or
 * screen-reader user needs from a single-page application that the browser no
 * longer provides on its own: **when the address changes, focus moves to the new
 * content.** A full page load puts focus at the top and announces the new title; a
 * client-side navigation does neither, so a keyboard user would find themselves
 * still on the link they pressed, in a page that has changed under them. Moving
 * focus to `<main>` (it is `tabIndex={-1}`: focusable by script, not by Tab) is the
 * minimum that makes a route change perceivable, and it is skipped on first render,
 * where the browser has already done it.
 */
import { useEffect, useRef } from 'react';
import { useI18n } from '../i18n/i18n-provider';
import { useRoute } from '../router/router-provider';
import { MAIN_ID, MainFocus } from '../ui/main';
import { SkipLink } from '../ui/skip-link';
import { Toaster } from '../ui/toast';
import { Outlet } from './outlet';
import { AppProviders, type AppPorts } from './providers';
import { AppSkeleton } from './skeleton';

const Frame = (): React.JSX.Element => {
  const { t } = useI18n();
  const { pathname } = useRoute();
  const first = useRef(true);
  const navigated = useRef(false);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    navigated.current = true;
    document.getElementById(MAIN_ID)?.focus();
  }, [pathname]);

  return (
    <>
      <SkipLink target={MAIN_ID}>{t('app.skip')}</SkipLink>
      <MainFocus.Provider value={navigated}>
        <Outlet />
      </MainFocus.Provider>
      <Toaster dismissLabel={t('common.close')} />
    </>
  );
};

interface AppProps {
  readonly ports?: AppPorts;
}

export const App = ({ ports }: AppProps): React.JSX.Element => (
  <AppProviders {...(ports === undefined ? {} : { ports })} fallback={<AppSkeleton />}>
    <Frame />
  </AppProviders>
);
