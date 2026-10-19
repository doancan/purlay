/**
 * The workspace menu: which workspace this is, a way to another or to a new one, and — for an owner or
 * an admin — inviting people and the workspace's settings (D-110, D-124, D-146). Everything else an
 * owner or an admin does is a page of Settings, where it has room; the menu keeps the one thing done
 * from inside a conversation, inviting somebody, as a quick dialog. Two doors open it — the workspace's name at the top of the
 * sidebar, with its chevron, as the design draws it, and the tile at the top of the rail — and both
 * are this one component, so there is one list of what it holds. A person is in one workspace at a
 * time (`UX.md` §2): one tile, not a column of them. Who is signed in, and signing out, are the
 * account menu's at the sidebar's foot (D-124).
 *
 * Switching is navigation to `/w/:slug`; the workspace the address names is the source of
 * truth, so there is no "current workspace" setting to fall out of step with the URL.
 */
import { useState } from 'react';
import { useDeferred } from '../../app/deferred-door';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { Icon } from '../../components/icon';
import { initialsOf } from '../../ui/avatar';
import { Dialog } from '../../ui/dialog';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '../../ui/menu';
import { useSession } from '../session/session';
import { CreateWorkspace } from '../shell/home';
import { useWorkspace } from '../shell/workspace';

interface WorkspaceMenuProps {
  /** Which door: the rail's tile, or the name at the top of the sidebar. */
  readonly door?: 'tile' | 'name';
}

export const WorkspaceMenu = ({ door = 'tile' }: WorkspaceMenuProps): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { memberships, mayCreateWorkspace } = useSession();
  const { navigate } = useRoute();
  const [inviting, setInviting] = useState(false);
  // The dialog is in the deferred chunk (D-163).
  const deferred = useDeferred([inviting, setInviting]);
  const [creating, setCreating] = useState(false);
  const role = memberships.find((membership) => membership.workspace.id === workspace.id)?.role;
  // Inviting and the workspace's settings are an owner's and an admin's (D-115, D-146); a member is
  // not offered what would be refused.
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
        {/* Offered only where the server would accept it (D-155). */}
        {mayCreateWorkspace && (
          <MenuItem
            glyph="add"
            onSelect={() => {
              setCreating(true);
            }}
          >
            {t('workspace.create.entry')}
          </MenuItem>
        )}
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
          <>
            <MenuSeparator />
            <MenuItem
              glyph="settings"
              onSelect={() => {
                navigate(href('settings', { slug: workspace.slug, section: 'general' }));
              }}
            >
              {t('workspace.settings.entry')}
            </MenuItem>
          </>
        )}
      </Menu>
      {deferred !== null && <deferred.InviteDialog open={inviting} onOpenChange={setInviting} />}
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
