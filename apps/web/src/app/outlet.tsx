/**
 * Which screen an address means.
 *
 * One switch over the route table, so adding a route is a compile error until it
 * has a screen: a module's routes are drawn from its manifest (`ModuleRoute`) before it, so the
 * core's routes are the cases, and one without a case does not compile.
 * Every route of a workspace renders inside one `Shell`, drawn once below the switch so a change between a
 * core screen and a module's keeps it standing; it is what makes a person, a workspace and a connection
 * true below it. The sign-in screen and the front door need only the person.
 *
 * **The gallery is a development tool and is not in the production build.** It is
 * a lazy chunk behind a condition Vite resolves *statically* (`import.meta.env.DEV`
 * is replaced by a literal, as is `VITE_GALLERY`), so when both are off the
 * dynamic `import()` is dead code and the bundler never emits the chunk — the
 * budget (#140) does not pay for a catalogue page. `VITE_GALLERY=1` builds it in,
 * which is how the browser tests photograph it from a production-shaped build.
 * It is a prop so a test can mount it without a build flag.
 */
import { LegacyServerRedirect } from '../features/administration/legacy';
import { lazy, Suspense, useEffect, type ComponentType } from 'react';
import { InviteScreen } from '../features/invitations/invite-screen';
import { MailStopScreen } from '../features/missed-mail/stop-screen';
import { SessionGate } from '../features/session/session';
import { Home } from '../features/shell/home';
import { NotFound } from '../features/shell/not-found';
import { Shell } from '../features/shell/shell';
import { WorkspaceHome } from '../features/shell/workspace-home';
import { SignInScreen } from '../features/sign-in/sign-in-screen';
import { EmailSignInScreen } from '../features/sign-in/email-sign-in-screen';
import { SignUpScreen } from '../features/sign-in/sign-up-screen';
import { useI18n } from '../i18n/i18n-provider';
import { useRoute } from '../router/router-provider';
import { isModuleMatch, moduleOf, type Match } from '../router/routes';
import { Skeleton, LoadingStatus } from '../ui/skeleton';
import { ModuleRoute, warmModule } from './module-route';
import { WelcomeScreen } from '../features/invitations/welcome-screen';
import { LazyNativeSignInScreen } from '../features/native/load';
import { LazyAdministration, LazySettingsScreen } from '../features/settings/load';
import { LazySetupScreen, LazyVerifyScreen } from '../features/setup/load';
import { FIRST_SECTION } from '../features/settings/sections';

declare global {
  /**
   * The build flag this file reads, typed where it is read. It is read with **dot
   * access** and never by index: Vite replaces `import.meta.env.VITE_GALLERY` with a
   * literal, which lets the bundler see `false || false` and drop the gallery's
   * chunk, where `import.meta.env['VITE_GALLERY']` is replaced by a whole object
   * that cannot be folded (measured: the chunk stayed in a production build). Not a
   * `.d.ts` file because a declaration file beside a source file is what the build
   * check refuses, as compiled output.
   */
  interface ImportMetaEnv {
    /** `1` builds the development gallery into this build. */
    readonly VITE_GALLERY?: string;
  }
}

/** The gallery's chunk. A function of its own so a test can ask for it without the build flag. */
export const loadGallery = (): Promise<{ default: ComponentType }> =>
  import('../gallery/gallery').then((module) => ({ default: module.Gallery }));

const defaultGallery: ComponentType | null =
  import.meta.env.DEV || import.meta.env.VITE_GALLERY === '1' ? lazy(loadGallery) : null;

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

/** A screen, and the workspace's shell it stands in, if any. */
interface Drawn {
  /** The workspace whose shell holds the screen; null for a screen that needs none. */
  readonly slug: string | null;
  readonly screen: React.JSX.Element;
}

const bare = (screen: React.JSX.Element): Drawn => ({ slug: null, screen });
const shelled = (slug: string, screen: React.JSX.Element): Drawn => ({ slug, screen });

const draw = (match: Match, gallery: ComponentType | null): Drawn => {
  // The modules' routes are drawn from their manifests; what is left is the core's, each a case below.
  if (isModuleMatch(match)) {
    return shelled(match.params.slug, <ModuleRoute name={match.name} params={match.params} />);
  }
  switch (match.name) {
    case 'signIn':
      return bare(<SignInScreen />);
    case 'signInEmail':
      return bare(<EmailSignInScreen />);
    case 'signInNative':
      return bare(
        <SessionGate>
          <LazyNativeSignInScreen />
        </SessionGate>,
      );
    case 'signUp':
      return bare(<SignUpScreen />);
    case 'setup':
      return bare(<LazySetupScreen />);
    case 'setupVerify':
      return bare(<LazyVerifyScreen />);
    case 'home':
      return bare(
        <SessionGate>
          <Home />
        </SessionGate>,
      );
    case 'serverHome':
      return bare(
        <SessionGate>
          <LazyAdministration section="overview" />
        </SessionGate>,
      );
    case 'serverSection':
      return bare(
        <SessionGate>
          <LazyAdministration section={match.params.section} />
        </SessionGate>,
      );
    case 'invite':
      return bare(<InviteScreen />);
    case 'mailStop':
      return bare(<MailStopScreen />);
    case 'workspace':
      return shelled(match.params.slug, <WorkspaceHome />);
    case 'welcome':
      return shelled(match.params.slug, <WelcomeScreen />);
    case 'settingsHome':
      return shelled(match.params.slug, <LazySettingsScreen section={FIRST_SECTION} />);
    case 'settings':
      if (match.params.section === 'server')
        return bare(
          <SessionGate>
            <LegacyServerRedirect />
          </SessionGate>,
        );
      return shelled(match.params.slug, <LazySettingsScreen section={match.params.section} />);
    case 'gallery': {
      const Gallery = gallery;
      return bare(
        Gallery === null ? (
          <NotFound />
        ) : (
          <Suspense fallback={<Loading />}>
            <Gallery />
          </Suspense>
        ),
      );
    }
    case 'notFound':
      return bare(<NotFound />);
  }
};

export const Outlet = ({ gallery = defaultGallery }: OutletProps): React.JSX.Element => {
  const { match } = useRoute();
  const owner = match.name === 'notFound' ? null : moduleOf(match.name);
  // Asked for in the first commit, beside the request for the session, so the chunk is not a second wait.
  useEffect(() => {
    warmModule(owner);
  }, [owner]);
  const { slug, screen } = draw(match, gallery);
  // One `Shell`, drawn here for every screen of a workspace: the front door hands over to a channel by
  // changing the route, and a shell drawn by each screen would be built again by it, closing a menu
  // opened on the first.
  return slug === null ? screen : <Shell slug={slug}>{screen}</Shell>;
};
