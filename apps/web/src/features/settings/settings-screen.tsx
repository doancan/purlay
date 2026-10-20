/**
 * The settings (D-146): which page an address names, for whoever may open it. This module and the
 * pages are a chunk of their own (`load.ts`), so the conversation's first load does not pay for
 * screens opened a few times a month.
 *
 * An address that names no page, or a page this person may not open, is *not found* — as any address
 * is — rather than a page that would only refuse them.
 */
import { NotFound } from '../shell/not-found';
import { AccountPage } from './pages/account';
import { AuditPage } from './pages/audit';
import { DataPage } from './pages/data';
import { GeneralPage } from './pages/general';
import { IntegrationsPage } from './pages/integrations';
import { InvitationsPage } from './pages/invitations';
import { MembersPage } from './pages/members';
import { NotificationsPage } from './pages/notifications';
import { PreferencesPage } from './pages/preferences';
import { ProfilePage } from './pages/profile';
import { ShortcutsPage } from './pages/shortcuts';
import { useWorkspaceRole } from './role';
import { sectionFor, type SettingsSectionId } from './sections';

const PAGES: Record<SettingsSectionId, () => React.JSX.Element> = {
  profile: ProfilePage,
  preferences: PreferencesPage,
  notifications: NotificationsPage,
  shortcuts: ShortcutsPage,
  account: AccountPage,
  general: GeneralPage,
  members: MembersPage,
  invitations: InvitationsPage,
  integrations: IntegrationsPage,
  audit: AuditPage,
  data: DataPage,
};

export const SettingsScreen = ({ section }: { readonly section: string }): React.JSX.Element => {
  const role = useWorkspaceRole();
  const found = sectionFor(section, role);
  if (found === null) return <NotFound />;
  const Page = PAGES[found.id];
  return <Page />;
};

export { SettingsNav } from './settings-nav';
