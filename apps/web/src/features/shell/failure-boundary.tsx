/**
 * What the page shows when something in it throws while drawing, instead of nothing at all.
 *
 * Two places, two reaches. `ScreenBoundary` is around the routed screen inside the shell, so the
 * rail and the sidebar outlive a screen that fails, and going anywhere else draws afresh: it is
 * keyed by the address. `AppBoundary` is under the words (`app/providers.tsx`) and catches
 * everything else that can still be said in the person's language; above it there is nothing to
 * say it in. Each says what happened and offers Reload and Go home — a full load, the one way out
 * that does not trust the state that just failed.
 *
 * **The report is React's.** A boundary that catches an error has React report it to the console
 * (`onCaughtError`'s default), which is the client's only report: the server's tracker (D-96)
 * does not reach the browser, and no second service is added for this. The boundary swallows
 * nothing — it only replaces a blank page with a way on.
 */
import { Component } from 'react';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { Button, buttonStyle } from '../../ui/button';
import { Main } from '../../ui/main';
import { Notice } from './notice';

class Boundary extends Component<
  { readonly fallback: React.ReactNode; readonly children: React.ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): React.ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const Failed = ({ reach }: { readonly reach: 'screen' | 'app' }): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <div role="alert" className="flex flex-1 flex-col">
      <Notice
        as="h1"
        glyph="failed"
        title={t(reach === 'screen' ? 'app.failed.screen' : 'app.failed.app')}
        body={t('app.failed.body')}
        action={
          <div className="flex gap-2">
            <Button
              variant="primary"
              onClick={() => {
                window.location.reload();
              }}
            >
              {t('app.failed.reload')}
            </Button>
            <a href={href('home')} className={buttonStyle('secondary')}>
              {t('app.failed.home')}
            </a>
          </div>
        }
      />
    </div>
  );
};

/** Around the routed screen; a new address is a new chance. */
export const ScreenBoundary = ({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element => {
  const { pathname } = useRoute();
  return (
    <Boundary key={pathname} fallback={<Failed reach="screen" />}>
      {children}
    </Boundary>
  );
};

/** Around everything below the words: the page's own `<main>`, since what had one is gone. */
export const AppBoundary = ({
  children,
}: {
  readonly children: React.ReactNode;
}): React.JSX.Element => (
  <Boundary
    fallback={
      <Main className="flex min-h-screen flex-col bg-surface-100 text-ink">
        <Failed reach="app" />
      </Main>
    }
  >
    {children}
  </Boundary>
);
