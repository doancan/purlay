/**
 * The workspace menu: which workspace this is, a way to another or to a new one, and what an owner
 * or an admin does to it (D-110, D-124). Two doors open it — the workspace's name at the top of the
 * sidebar, with its chevron, as the design draws it, and the tile at the top of the rail — and both
 * are this one component, so there is one list of what it holds. A person is in one workspace at a
 * time (`UX.md` §2): one tile, not a column of them. Who is signed in, and signing out, are the
 * account menu's at the sidebar's foot (D-124).
 *
 * Switching is navigation to `/w/:slug`; the workspace the address names is the source of
 * truth, so there is no "current workspace" setting to fall out of step with the URL.
 */
import { useState } from 'react';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { Icon } from '../../components/icon';
import { initialsOf } from '../../ui/avatar';
import { Dialog } from '../../ui/dialog';
import { Menu, MenuItem, MenuLabel } from '../../ui/menu';
import { useSession } from '../session/session';
import { CreateWorkspace } from '../shell/home';
import { useWorkspace } from '../shell/workspace';
import { AuditDialog } from './audit-dialog';
import { GitHubDialog } from './github-dialog';
import { InviteDialog } from './invite-dialog';
import { MembersDialog } from './members-dialog';
import { WorkspaceSettingsDialog } from './workspace-settings-dialog';
import { RetentionDialog } from './retention-dialog';

interface WorkspaceMenuProps {
  /** Which door: the rail's tile, or the name at the top of the sidebar. */
  readonly door?: 'tile' | 'name';
}

export const WorkspaceMenu = ({ door = 'tile' }: WorkspaceMenuProps): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { memberships } = useSession();
  const { navigate } = useRoute();
  const [inviting, setInviting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [managing, setManaging] = useState(false);
  const [auditing, setAuditing] = useState(false);
  const [settling, setSettling] = useState(false);
  const [creating, setCreating] = useState(false);
  const [keeping, setKeeping] = useState(false);
  const role = memberships.find((membership) => membership.workspace.id === workspace.id)?.role;
  // Making links and the GitHub token are an owner's and an admin's (D-115, D-23); a member is not
  // offered what would be refused.
  const mayInvite = role === 'owner' || role === 'admin';

  return (
    <>
      <Menu
        side={door === 'tile' ? 'right' : 'bottom'}
        trigger={
          door === 'tile' ? (
            <button
              type="button"
              aria-label={t('sidebar.switch')}
              className="inline-flex size-avatar-lg items-center justify-center rounded-xl bg-accent text-heading text-on-accent transition-colors duration-hover ease-standard hover:bg-accent-hover max-narrow:h-touch max-narrow:w-touch"
            >
              {initialsOf(workspace.name)}
            </button>
          ) : (
            <button
              type="button"
              className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors duration-hover ease-standard hover:bg-nav-hover"
            >
              <span className="min-w-0 flex-1 truncate text-title text-nav-ink">
                {workspace.name}
              </span>
              <span className="text-nav-ink-muted">
                <Icon name="switch" />
              </span>
            </button>
          )
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
        <MenuItem
          glyph="add"
          onSelect={() => {
            setCreating(true);
          }}
        >
          {t('workspace.create.entry')}
        </MenuItem>
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
        {/* How long history is kept is an owner's alone (D-139 §4). */}
        {role === 'owner' && (
          <MenuItem
            glyph="settings"
            onSelect={() => {
              setKeeping(true);
            }}
          >
            {t('retention.entry')}
          </MenuItem>
        )}
      </Menu>
      <InviteDialog open={inviting} onOpenChange={setInviting} />
      <GitHubDialog open={connecting} onOpenChange={setConnecting} />
      <MembersDialog open={managing} onOpenChange={setManaging} />
      <AuditDialog open={auditing} onOpenChange={setAuditing} />
      <WorkspaceSettingsDialog open={settling} onOpenChange={setSettling} />
      <RetentionDialog open={keeping} onOpenChange={setKeeping} />
      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title={t('workspace.create.title')}
        description={t('workspace.create.body')}
        closeLabel={t('common.close')}
      >
        <CreateWorkspace
          framed={false}
          onCreated={() => {
            setCreating(false);
          }}
        />
      </Dialog>
    </>
  );
};
