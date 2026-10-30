/**
 * The workspace menu: which workspace this is, a way to another or to a new one, and — for an owner or
 * an admin — inviting people and the workspace's settings (D-110, D-124, D-146). Everything else an
 * owner or an admin does is a page of Settings, where it has room; the menu keeps the one thing done
 * from inside a conversation, inviting somebody, as a quick dialog. One door opens it: the workspace's
 * mark and name at the top of the sidebar, with its chevron (D-206). A person is in one workspace at a
 * time (`UX.md` §2), so a tile on the rail beside it only drew the same workspace twice, a hand's width
 * apart; the rail is the places. Who is signed in, and signing out, are the account menu's at the
 * sidebar's foot (D-124).
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
import { useToast } from '../../ui/toast';
import { useContentPorts } from '../content/content-ports';
import { useSession } from '../session/session';
import { CreateWorkspace } from '../shell/home';
import { useWorkspace } from '../shell/workspace';
import { VisuallyHidden } from '../../ui/visually-hidden';

export const WorkspaceMenu = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { memberships, mayCreateWorkspace } = useSession();
  const { navigate } = useRoute();
  const [inviting, setInviting] = useState(false);
  // The dialog is in the deferred chunk (D-163).
  const deferred = useDeferred([inviting, setInviting]);
  const [creating, setCreating] = useState(false);
  const { show } = useToast();
  const { copy } = useContentPorts();
  /** The workspace's own address, whole: what a person pastes to somebody who already has an account. */
  const copyLink = (): void => {
    const link = new URL(href('workspace', { slug: workspace.slug }), window.location.origin).href;
    copy(link).then(
      () => {
        show({ message: t('rowMenu.linkCopied') });
      },
      () => {
        show({ message: t('failure.copy') });
      },
    );
  };
  const role = memberships.find((membership) => membership.workspace.id === workspace.id)?.role;
  // Inviting and the workspace's settings are an owner's and an admin's (D-115, D-146); a member is
  // not offered what would be refused.
  const mayInvite = role === 'owner' || role === 'admin';

  return (
    <>
      <Menu
        side="bottom"
        trigger={
          // Inset and rounded as every row under it is, so the hover and the focus ring sit inside the
          // column instead of running into the rail and the hairline.
          <button
            type="button"
            className="flex h-control min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left transition-colors duration-hover ease-standard hover:bg-nav-hover max-narrow:h-touch"
          >
            {/* A picture of the workspace, as an avatar's initials are; the name beside it says it. */}
            <span
              aria-hidden="true"
              className="inline-flex size-avatar-sm shrink-0 items-center justify-center rounded-md bg-accent text-caption text-on-accent"
            >
              {initialsOf(workspace.name)}
            </span>
            <span className="min-w-0 flex-1 truncate text-title text-nav-ink">
              {workspace.name}
            </span>
            {/* The name is what is seen, so it is first in what is heard; then what it does. */}
            <VisuallyHidden> {t('sidebar.switch')}</VisuallyHidden>
            <span className="text-nav-ink-muted">
              <Icon name="switch" />
            </span>
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
        <MenuItem glyph="invite" onSelect={copyLink}>
          {t('sidebar.workspace.copyLink')}
        </MenuItem>
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
          onCancel={() => {
            setCreating(false);
          }}
        />
      </Dialog>
    </>
  );
};
