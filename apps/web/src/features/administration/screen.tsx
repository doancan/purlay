import { ServerPushCard } from './push';
/** Workspace-independent administration. Only the session's server administrator reaches its queries. */
import { useSignOut } from '../shell/sign-out';
import { Backups } from './backups';
import { ServerPreferencesCard } from './preferences';
import { useId, useState } from 'react';
import { useI18n } from '../../i18n/i18n-provider';
import { Link } from '../../router/router-provider';
import { Button } from '../../ui/button';
import { Main } from '../../ui/main';
import { cn } from '../../ui/cn';
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

const sections = [
  'overview',
  'users',
  'workspaces',
  'security',
  'email',
  'data',
  'integrations',
  'operations',
  'audit',
] as const;
type Section = (typeof sections)[number];
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
      <aside className="flex w-sidebar shrink-0 flex-col gap-4 narrow:border-r-hairline border-border-subtle bg-nav-surface p-4 max-narrow:w-full max-narrow:border-b-hairline">
        <div className="flex items-center justify-between gap-3">
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
          className={cn('flex flex-col gap-1', !open && 'max-narrow:hidden')}
        >
          <Link
            to="home"
            className="rounded-lg px-3 py-2 text-body text-nav-ink-muted hover:bg-nav-hover"
          >
            {t('admin.back')}
          </Link>
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
                'rounded-lg px-3 py-2 text-body break-words max-narrow:min-h-touch',
                item === section
                  ? 'bg-nav-selected font-semibold text-nav-ink'
                  : 'text-nav-ink-muted hover:bg-nav-hover hover:text-nav-ink',
              )}
            >
              {t(`admin.${item}`)}
            </Link>
          ))}
          <Button
            variant="ghost"
            onClick={() => {
              leave('here');
            }}
          >
            {t('user.signOut')}
          </Button>
        </nav>
      </aside>
      <Main
        key={section}
        className="min-w-0 flex-1 px-10 pt-10 pb-16 max-narrow:px-4 max-narrow:pt-6"
      >
        <div className="mx-auto flex w-full flex-col gap-6">
          <header className="flex flex-col gap-2">
            <h1 className="text-display text-ink">{t(`admin.${section}`)}</h1>
            <p className="text-body text-ink-muted">{t(`admin.${section}.body`)}</p>
          </header>
          <Content section={section} />
        </div>
      </Main>
    </div>
  );
};
