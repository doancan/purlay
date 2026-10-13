/**
 * The workspace tile at the top of the rail: which workspace this is, a way to another, and what
 * an owner or an admin does to it — one menu (D-110). The rail holds the tile because a person is
 * in one workspace at a time (`UX.md` §2): one tile, not a column of them. Who is signed in, and
 * signing out, are the account menu's at the sidebar's foot (D-124).
 *
 * Switching is navigation to `/w/:slug`; the workspace the address names is the source of
 * truth, so there is no "current workspace" setting to fall out of step with the URL.
 */
import { useState } from 'react';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { initialsOf } from '../../ui/avatar';
import { Menu, MenuItem, MenuLabel } from '../../ui/menu';
import { useSession } from '../session/session';
import { useWorkspace } from '../shell/workspace';
import { AuditDialog } from './audit-dialog';
import { GitHubDialog } from './github-dialog';
import { InviteDialog } from './invite-dialog';
import { MembersDialog } from './members-dialog';
import { WorkspaceSettingsDialog } from './workspace-settings-dialog';

export const WorkspaceMenu = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { memberships } = useSession();
  const { navigate } = useRoute();
  const [inviting, setInviting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [managing, setManaging] = useState(false);
  const [auditing, setAuditing] = useState(false);
  const [settling, setSettling] = useState(false);
  const role = memberships.find((membership) => membership.workspace.id === workspace.id)?.role;
  // Making links and the GitHub token are an owner's and an admin's (D-115, D-23); a member is not
  // offered what would be refused.
  const mayInvite = role === 'owner' || role === 'admin';

  return (
    <>
      <Menu
        side="right"
        trigger={
          <button
            type="button"
            aria-label={t('sidebar.switch')}
            className="inline-flex size-avatar-lg items-center justify-center rounded-xl bg-accent text-heading text-on-accent transition-colors duration-hover ease-standard hover:bg-accent-hover max-narrow:h-touch max-narrow:w-touch"
          >
            {initialsOf(workspace.name)}
          </button>
        }
      >
        <MenuLabel>{t('sidebar.workspaces')}</MenuLabel>
        {memberships.map((membership) => (
          <MenuItem
            key={membership.workspace.id}
            {...(membership.workspace.id === workspace.id ? { glyph: 'confirm' as const } : {})}
            onSelect={() => {
              navigate(href('workspace', { slug: membership.workspace.slug }));
            }}
          >
            {membership.workspace.name}
          </MenuItem>
        ))}
        {mayInvite && (
          <MenuItem
            glyph="person"
            onSelect={() => {
              setInviting(true);
            }}
          >
            {t('invite.admin.entry')}
          </MenuItem>
        )}
        {mayInvite && (
          <MenuItem
            glyph="settings"
            onSelect={() => {
              setManaging(true);
            }}
          >
            {t('members.entry')}
          </MenuItem>
        )}
        {mayInvite && (
          <MenuItem
            glyph="merged"
            onSelect={() => {
              setConnecting(true);
            }}
          >
            {t('github.entry')}
          </MenuItem>
        )}
        {mayInvite && (
          <MenuItem
            glyph="shortcuts"
            onSelect={() => {
              setAuditing(true);
            }}
          >
            {t('audit.entry')}
          </MenuItem>
        )}
        {mayInvite && (
          <MenuItem
            glyph="settings"
            onSelect={() => {
              setSettling(true);
            }}
          >
            {t('workspace.settings.entry')}
          </MenuItem>
        )}
      </Menu>
      <InviteDialog open={inviting} onOpenChange={setInviting} />
      <GitHubDialog open={connecting} onOpenChange={setConnecting} />
      <MembersDialog open={managing} onOpenChange={setManaging} />
      <AuditDialog open={auditing} onOpenChange={setAuditing} />
      <WorkspaceSettingsDialog open={settling} onOpenChange={setSettling} />
    </>
  );
};
