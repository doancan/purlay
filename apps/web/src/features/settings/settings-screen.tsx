/**
 * The settings (D-146): which page an address names, for whoever may open it. This module and the
 * pages are a chunk of their own (`load.ts`), so the conversation's first load does not pay for
 * screens opened a few times a month.
 *
 * An address that names no page, or a page this person may not open, is *not found* — as any address
 * is — rather than a page that would only refuse them.
 */
import { lazy, Suspense, type ComponentType, type LazyExoticComponent } from 'react';
import type { ModuleSettingsPage } from '../../modules/manifest';
import { useI18n } from '../../i18n/i18n-provider';
import { LoadingStatus, Skeleton } from '../../ui/skeleton';
import { NotFound } from '../shell/not-found';
import { AboutPage } from './pages/about';
import { AccountPage } from './pages/account';
import { AuditPage } from './pages/audit';
import { DataPage } from './pages/data';
import { GeneralPage } from './pages/general';
import { InvitationsPage } from './pages/invitations';
import { MembersPage } from './pages/members';
import { PreferencesPage } from './pages/preferences';
import { ProfilePage } from './pages/profile';
import { ServerPage } from './pages/server';
import { ShortcutsPage } from './pages/shortcuts';
import { useModules } from '../session/session';
import { useIsServerAdmin, useWorkspaceRole } from './role';
import { sectionFor, type CoreSettingsSectionId } from './sections';

const PAGES: Record<CoreSettingsSectionId, () => React.JSX.Element> = {
  profile: ProfilePage,
  preferences: PreferencesPage,
  shortcuts: ShortcutsPage,
  account: AccountPage,
  about: AboutPage,
  general: GeneralPage,
  members: MembersPage,
  invitations: InvitationsPage,
  audit: AuditPage,
  data: DataPage,
  server: ServerPage,
};

type Loader = NonNullable<ModuleSettingsPage['load']>;
const LOADED_PAGES = new WeakMap<Loader, LazyExoticComponent<ComponentType>>();
const loadedPage = (load: Loader): LazyExoticComponent<ComponentType> => {
  const previous = LOADED_PAGES.get(load);
  if (previous !== undefined) return previous;
  const page = lazy(load);
  LOADED_PAGES.set(load, page);
  return page;
};

export const SettingsScreen = ({ section }: { readonly section: string }): React.JSX.Element => {
  const { t } = useI18n();
  const role = useWorkspaceRole();
  const found = sectionFor(section, role, useIsServerAdmin(), useModules());
  if (found === null) return <NotFound />;
  if (found.module === undefined) {
    const CorePage = PAGES[found.id];
    return <CorePage />;
  }
  const Page = loadedPage(found.load);
  return (
    <Suspense
      fallback={
        <LoadingStatus label={t('common.loading')} className="p-6">
          <Skeleton />
          <Skeleton />
        </LoadingStatus>
      }
    >
      <Page />
    </Suspense>
  );
};

export { SettingsNav } from './settings-nav';
