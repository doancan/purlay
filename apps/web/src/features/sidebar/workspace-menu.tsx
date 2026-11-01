/**
 * The workspace menu: which workspace this is, a way to another or to a new one, marking every channel
 * in it read (`Shift+Esc`, D-238), and — for an owner or an admin — inviting people and the workspace's
 * settings (D-110, D-124, D-146). Everything else an owner or an admin does is a page of Settings,
 * where it has room; the menu keeps the one thing done from inside a conversation, inviting somebody,
 * as a quick dialog. One door opens it: the workspace's
 * mark and name at the top of the sidebar, with its chevron (D-206). A person is in one workspace at a
 * time (`UX.md` §2), so a tile on the rail beside it only drew the same workspace twice, a hand's width
 * apart; the rail is the places. Who is signed in, and signing out, are the account menu's at the
 * sidebar's foot (D-124).
 *
 * Switching is navigation to `/w/:slug`; the workspace the address names is the source of
 * truth, so there is no "current workspace" setting to fall out of step with the URL.
 */
import { useMemo, useState } from 'react';
import { useDeferred } from '../../app/deferred-door';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { Icon } from '../../components/icon';
import { Avatar, initialsOf } from '../../ui/avatar';
import { Dialog } from '../../ui/dialog';
import {
  Menu,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from '../../ui/menu';
import { useMembers } from '../../data/queries';
import { useToast } from '../../ui/toast';
import { useContentPorts } from '../content/content-ports';
import { useSession } from '../session/session';
import { CreateWorkspace } from '../shell/home';
import { useMarkAllRead } from '../shell/read-all';
import { isMacPlatform, keyLabels } from '../shortcuts/platform';
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
  const markAllRead = useMarkAllRead();
  const readAllKeys = useMemo(() => {
    const mac = isMacPlatform(navigator);
    const labels = keyLabels(mac);
    return [labels.shift, labels.escape].join(mac ? '' : '+');
  }, []);
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
  // The People list reads the same query, so this is the cache's answer, not another request.
  const members = useMembers(workspace.id).data;
  const standing = [
    ...(role === undefined ? [] : [t(`members.role.${role}`)]),
    ...(members === undefined ? [] : [t('sidebar.workspace.members', { count: members.length })]),
  ].join(' · ');

  return (
    <>
      <Menu
        side="bottom"
        trigger={
          // A card (D-209): framed and lifted off the column, the workspace's mark, its name, and who
          // you are in it — so the one door to the workspace says which, at a glance, and looks like one.
          // Hover tints the fill in the accent's family and open frames it in the accent: the edge's
          // grammar (D-188) — hover changes the fill, never the line.
          <button
            type="button"
            className="group flex min-w-0 flex-1 items-center gap-2 rounded-xl border-hairline border-nav-border bg-nav-surface p-1 pr-2 text-left shadow-card transition-colors duration-hover ease-standard hover:bg-nav-selected data-[state=open]:border-accent data-[state=open]:bg-nav-selected max-narrow:min-h-touch"
          >
            {/* A picture of the workspace, as an avatar's initials are; the name beside it says it. */}
            <span
              aria-hidden="true"
              className="inline-flex size-avatar shrink-0 items-center justify-center rounded-lg bg-accent text-caption font-semibold text-on-accent"
            >
              {initialsOf(workspace.name)}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-label font-semibold text-nav-ink">
                {workspace.name}
              </span>
              {/* Seen, not heard: the button's name is the workspace and what it does, kept short. */}
              <span aria-hidden="true" className="truncate text-caption text-nav-ink-muted">
                {standing}
              </span>
            </span>
            {/* The name is what is seen, so it is first in what is heard; then what it does. */}
            <VisuallyHidden> {t('sidebar.switch')}</VisuallyHidden>
            <span className="text-nav-ink-muted transition-colors duration-hover ease-standard group-hover:text-accent-text">
              <Icon name="switch" />
            </span>
          </button>
        }
      >
        <MenuLabel>{t('sidebar.workspaces')}</MenuLabel>
        {/* One of several, so a radio: a screen reader says which one is this, not only the eye. */}
        <MenuRadioGroup
          value={workspace.id}
          onValueChange={(id) => {
            const next = memberships.find((membership) => membership.workspace.id === id);
            if (next !== undefined) navigate(href('workspace', { slug: next.workspace.slug }));
          }}
        >
          {memberships.map(({ workspace: each }) => (
            <MenuRadioItem
              key={each.id}
              value={each.id}
              leading={{
                textValue: each.name,
                // This one in the accent, as its card is; the others each in their own tint.
                node:
                  each.id === workspace.id ? (
                    <span
                      aria-hidden="true"
                      className="inline-flex size-avatar-sm shrink-0 items-center justify-center rounded-md bg-accent text-caption font-semibold text-on-accent"
                    >
                      {initialsOf(each.name)}
                    </span>
                  ) : (
                    <Avatar size="sm" name={each.name} username={each.slug} />
                  ),
              }}
            >
              {each.name}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
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
        <MenuItem glyph="confirm" shortcut={readAllKeys} onSelect={markAllRead}>
          {t('readAll.label')}
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
