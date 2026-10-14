/**
 * Which screen an address means.
 *
 * One switch over the route table, so adding a route is a compile error until it
 * has a screen: `Match['name']` is exhaustive here, and `default` is not written.
 * Every signed-in route renders inside `Shell`, which is what makes a person, a
 * workspace and a connection true below it; the sign-in screen and the front door
 * need only the person.
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
import { ChannelScreen } from '../features/channel/channel-screen';
import { InboxScreen } from '../features/inbox/inbox-screen';
import { InviteScreen } from '../features/invitations/invite-screen';
import { QuestionsScreen } from '../features/questions/questions-screen';
import { SearchScreen } from '../features/search/search-screen';
import { SessionGate } from '../features/session/session';
import { Home } from '../features/shell/home';
import { NotFound } from '../features/shell/not-found';
import { Shell } from '../features/shell/shell';
import { WorkspaceHome } from '../features/shell/workspace-home';
import { SignInScreen } from '../features/sign-in/sign-in-screen';
import { EmailSignInScreen } from '../features/sign-in/email-sign-in-screen';
import { useI18n } from '../i18n/i18n-provider';
import { useRoute } from '../router/router-provider';
import { Skeleton, LoadingStatus } from '../ui/skeleton';
import { SavedScreen } from '../features/saved/saved-screen';
import { WelcomeScreen } from '../features/invitations/welcome-screen';

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

export const Outlet = ({ gallery = defaultGallery }: OutletProps): React.JSX.Element => {
  const { match } = useRoute();
  switch (match.name) {
    case 'signIn':
      return <SignInScreen />;
    case 'signInEmail':
      return <EmailSignInScreen />;
    case 'home':
      return (
        <SessionGate>
          <Home />
        </SessionGate>
      );
    case 'invite':
      return (
        <SessionGate>
          <InviteScreen />
        </SessionGate>
      );
    case 'workspace':
      return (
        <Shell slug={match.params.slug}>
          <WorkspaceHome />
        </Shell>
      );
    case 'channel':
      return (
        <Shell slug={match.params.slug}>
          <ChannelScreen channelId={match.params.channelId} />
        </Shell>
      );
    case 'questions':
      return (
        <Shell slug={match.params.slug}>
          <QuestionsScreen />
        </Shell>
      );
    case 'inbox':
      return (
        <Shell slug={match.params.slug}>
          <InboxScreen />
        </Shell>
      );
    case 'search':
      return (
        <Shell slug={match.params.slug}>
          <SearchScreen />
        </Shell>
      );
    case 'saved':
      return (
        <Shell slug={match.params.slug}>
          <SavedScreen />
        </Shell>
      );
    case 'welcome':
      return (
        <Shell slug={match.params.slug}>
          <WelcomeScreen />
        </Shell>
      );
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
