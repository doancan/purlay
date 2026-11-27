import { ServerPushCard } from './push';
/** Workspace-independent administration. Only the session's server administrator reaches its queries. */
import { useSignOut } from '../shell/sign-out';
import { Backups } from './backups';
import { ServerPreferencesCard } from './preferences';
import { lazy, Suspense, useId, useState } from 'react';
import { Icon, type GlyphName } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import { Link } from '../../router/router-provider';
import { Button } from '../../ui/button';
import { Main } from '../../ui/main';
import { cn } from '../../ui/cn';
import { navRowAwayClasses, navRowClasses, navRowHereClasses } from '../../ui/nav-row';
import { useSession } from '../session/session';
import { NotFound } from '../shell/not-found';
import { GitHubCard, EmailCard } from '../settings/pages/server-channels';
import { GoogleCard } from '../settings/pages/server-google';
import { OidcCard } from '../settings/pages/server-oidc';
import { GitHubAppCard } from '../settings/pages/server-github-app';
import {
  CreatorsCard,
  PolicyCard,
  SessionLifetimeCard,
  SignInPolicyCard,
} from '../settings/pages/server-policies';
import { ServerSettingsState } from '../settings/pages/server';
import { SavedMailTest } from './email';
import { Audit } from './audit';
import { Overview, Operations, DeploymentInventory } from './status';
import { Users } from './users';
import { Workspaces } from './workspaces';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';

// Opened a few times a year, by one person: its own chunk, so the console's does not carry it.
const Modules = lazy(async () => ({ default: (await import('./modules')).Modules }));

const sections = [
  'overview',
  'users',
  'workspaces',
  'modules',
  'security',
  'email',
  'data',
  'integrations',
  'operations',
  'audit',
] as const;
type Section = (typeof sections)[number];

/** The mark beside each section's name, from the same set the settings' navigation draws from. */
const glyphs: Readonly<Record<Section, GlyphName>> = {
  overview: 'info',
  users: 'person',
  workspaces: 'groups',
  modules: 'integration',
  security: 'shield',
  email: 'notifications',
  data: 'table',
  integrations: 'link',
  operations: 'settings',
  audit: 'audit',
};
const isSection = (name: string): name is Section => sections.some((section) => section === name);

const Configuration = ({
  section,
}: {
  readonly section: 'security' | 'email' | 'integrations';
}): React.JSX.Element => {
  const runsChat = useSession().modules.includes('chat');
  const { t } = useI18n();
  return (
    <ServerSettingsState>
      {(view) =>
        section === 'security' ? (
          <>
            <ServerPreferencesCard />
            <GitHubCard view={view} />
            <GoogleCard view={view} />
            <OidcCard view={view} />
            <PolicyCard view={view} />
            <SignInPolicyCard view={view} />
            <SessionLifetimeCard view={view} />
            <CreatorsCard view={view} />
          </>
        ) : section === 'email' ? (
          <>
            <EmailCard view={view} />
            <SavedMailTest enabled={view.settings.smtp !== null} email={view.adminEmail} />
          </>
        ) : (
          <>
            {runsChat ? (
              <GitHubAppCard view={view} />
            ) : (
              <p className="text-body text-ink-muted">{t('admin.integrationDisabled')}</p>
            )}
            <DeploymentInventory />
          </>
        )
      }
    </ServerSettingsState>
  );
};
const LazyModules = (): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <Suspense
      fallback={
        <LoadingStatus label={t('common.loading')}>
          <Skeleton />
          <Skeleton />
        </LoadingStatus>
      }
    >
      <Modules />
    </Suspense>
  );
};
const Content = ({ section }: { readonly section: Section }): React.JSX.Element => {
  switch (section) {
    case 'overview':
      return (
        <>
          <Overview />
          <ServerPreferencesCard identity />
        </>
      );
    case 'users':
      return <Users />;
    case 'workspaces':
      return <Workspaces />;
    case 'modules':
      return <LazyModules />;
    case 'email':
      return (
        <>
          <ServerPushCard />
          <Configuration section={section} />
        </>
      );
    case 'security':
    case 'integrations':
      return <Configuration section={section} />;
    case 'data':
      return <Workspaces dataOnly />;
    case 'operations':
      return (
        <>
          <Backups />
          <Operations />
          <DeploymentInventory />
        </>
      );
    case 'audit':
      return <Audit />;
  }
};
export const AdministrationScreen = ({
  section,
}: {
  readonly section: string;
}): React.JSX.Element => {
  const session = useSession();
  const leave = useSignOut();
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const navId = useId();
  if (!session.isServerAdmin || !isSection(section)) return <NotFound />;
  return (
    <div className="flex min-h-screen bg-surface-000 text-ink max-narrow:flex-col">
      <aside className="flex w-sidebar shrink-0 flex-col narrow:sticky narrow:top-0 narrow:h-screen narrow:border-r-hairline border-border-subtle bg-nav-surface max-narrow:w-full max-narrow:border-b-hairline">
        <div className="flex h-header shrink-0 items-center justify-between gap-3 border-b-hairline border-nav-border px-4">
          <p className="text-title text-nav-ink">{t('admin.title')}</p>
          <span className="hidden max-narrow:inline-flex">
            <Button
              aria-expanded={open}
              aria-controls={navId}
              onClick={() => {
                setOpen((value) => !value);
              }}
            >
              {t('admin.menu')}
            </Button>
          </span>
        </div>
        <nav
          id={navId}
          aria-label={t('admin.nav')}
          className={cn(
            'flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-2 pt-2 pb-4',
            !open && 'max-narrow:hidden',
          )}
        >
          <Link to="home" className={cn(navRowClasses, navRowAwayClasses)}>
            <Icon name="back" />
            <span className="min-w-0 flex-1 truncate">{t('admin.back')}</span>
          </Link>
          <div className="my-2 border-t-hairline border-nav-border" />
          {sections.map((item) => (
            <Link
              key={item}
              to="serverSection"
              params={{ section: item }}
              aria-current={item === section ? 'page' : undefined}
              onClick={() => {
                setOpen(false);
              }}
              className={cn(
                navRowClasses,
                item === section ? navRowHereClasses : navRowAwayClasses,
              )}
            >
              <Icon name={glyphs[item]} />
              <span className="min-w-0 flex-1 truncate">{t(`admin.${item}`)}</span>
            </Link>
          ))}
          <button
            type="button"
            onClick={() => {
              leave('here');
            }}
            className={cn(navRowClasses, navRowAwayClasses, 'mt-auto')}
          >
            <Icon name="sign-out" />
            <span className="min-w-0 flex-1 truncate text-left">{t('user.signOut')}</span>
          </button>
        </nav>
      </aside>
      <Main
        key={section}
        className="min-w-0 flex-1 px-10 pt-10 pb-16 max-narrow:px-4 max-narrow:pt-6 max-narrow:pb-10"
      >
        {/* The settings pages' shape (`SettingsPage`): the title and its sentence as one group, further from the cards than the cards are from each other. */}
        <div className="flex w-full flex-col gap-8 max-narrow:gap-6">
          <header className="flex flex-col gap-1">
            <h1 className="text-display text-ink">{t(`admin.${section}`)}</h1>
            <p className="text-body text-ink-muted">{t(`admin.${section}.body`)}</p>
          </header>
          <div className="flex flex-col gap-6">
            <Content section={section} />
          </div>
        </div>
      </Main>
    </div>
  );
};
