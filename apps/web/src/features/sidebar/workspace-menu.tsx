/**
 * The workspace tile at the top of the rail: which workspace this is, a way to another, and who
 * is signed in — one menu (D-110). The rail holds the tile because a person is in one workspace at
 * a time (`UX.md` §2): one tile, not a column of them.
 *
 * Switching is navigation to `/w/:slug`; the workspace the address names is the source of
 * truth, so there is no "current workspace" setting to fall out of step with the URL.
 * Signing out asks the server and then forgets the page's cache (`actions.signOut`) before
 * leaving, so the next person on this screen inherits nothing; `replace` keeps Back from
 * returning to a page that would only bounce to sign-in. A sign-out the server refuses is a
 * toast and the person stays where they are: signed in, and told.
 */
import { useState } from 'react';
import { useActions } from '../../data/actions-provider';
import { useDescribeFailure } from '../../data/failure';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { initialsOf } from '../../ui/avatar';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '../../ui/menu';
import { useToast } from '../../ui/toast';
import { useSession } from '../session/session';
import { useWorkspace } from '../shell/workspace';
import { GitHubDialog } from './github-dialog';
import { InviteDialog } from './invite-dialog';
import { MembersDialog } from './members-dialog';

export const WorkspaceMenu = (): React.JSX.Element => {
  const { t } = useI18n();
  const { workspace } = useWorkspace();
  const { user, memberships } = useSession();
  const { signOut } = useActions();
  const { navigate } = useRoute();
  const { show } = useToast();
  const describe = useDescribeFailure();
  const [inviting, setInviting] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [managing, setManaging] = useState(false);
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
            className="inline-flex size-avatar-lg items-center justify-center rounded-lg bg-accent text-label font-semibold text-on-accent transition-colors duration-hover ease-standard hover:bg-accent-hover max-narrow:h-touch max-narrow:w-touch"
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
        <MenuSeparator />
        <MenuLabel>{t('sidebar.signedInAs', { name: user.displayName })}</MenuLabel>
        <MenuItem
          glyph="sign-out"
          onSelect={() => {
            // A refused sign-out leaves the person signed in and says so; going to the sign-in
            // screen anyway would bounce straight back and look like nothing happened.
            void signOut().then(
              () => {
                navigate(href('signIn'), { replace: true });
              },
              (error: unknown) => {
                show({ message: `${t('failure.signOut')} ${describe(error)}` });
              },
            );
          }}
        >
          {t('user.signOut')}
        </MenuItem>
      </Menu>
      <InviteDialog open={inviting} onOpenChange={setInviting} />
      <GitHubDialog open={connecting} onOpenChange={setConnecting} />
      <MembersDialog open={managing} onOpenChange={setManaging} />
    </>
  );
};
