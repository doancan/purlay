/**
 * The account menu, from the sidebar's foot: who you are, and what you reach for often (D-124,
 * D-146, D-207) — Deep Work, Settings, the shortcut reference, and signing out. Everything else that is the
 * person's — the theme, the language, this device's notifications, signing out everywhere and erasing
 * the account — is a page of Settings, where it has room to say what it does.
 *
 * - **Deep Work** is started for a while chosen here — half an hour, one, two, or until tomorrow
 *   morning — and the instant is what the server is sent, so it is the server's delivery that stops
 *   (D-15, D-108). On, it says until when and how long is left, and offers its end.
 * - **Settings** opens the person's Profile page; `Cmd/Ctrl+,` opens it from anywhere.
 *
 * Its door is drawn as the account switchers of Linear, Vercel and GitHub are (D-207): the
 * avatar with the dot that says you are online, the name over the handle, and the up-and-down
 * chevron that says a menu opens — not the sliders, which beside the workspace's name are the
 * sidebar's options. The menu opens with who you are, as a card, and keeps Deep Work's whiles
 * in a submenu, so the four of them do not outnumber everything else in it.
 */
import { useMemo } from 'react';
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { Avatar } from '../../ui/avatar';
import { Menu, MenuItem, MenuLabel, MenuSeparator, MenuSub } from '../../ui/menu';
import { useOnline } from '../../realtime/realtime-provider';
import { useSession } from '../session/session';
import { isMacPlatform, keyLabels } from '../shortcuts/platform';
import { DEEP_WORK_CHOICES, useDeepWorkControls } from './deep-work';
import { useShortcutsDoor } from './overlay';
import { useSignOut } from './sign-out';
import { useWorkspace } from './workspace';
import { VisuallyHidden } from '../../ui/visually-hidden';

/**
 * Deep Work's part of the menu: a submenu of the whiles to start it for — or, while it is on, how
 * long is left, said in the open, and its end, one step away rather than two.
 */
const DeepWorkItems = (): React.JSX.Element | null => {
  const { t, format } = useI18n();
  const deepWork = useDeepWorkControls();
  if (deepWork === null) return null;
  const { until } = deepWork;
  return (
    <>
      {until === null ? (
        <MenuSub glyph="deep-work" label={t('deepWork.label')}>
          {DEEP_WORK_CHOICES.map((choice) => (
            <MenuItem
              key={choice}
              onSelect={() => {
                deepWork.start(choice);
              }}
            >
              {t(`deepWork.choice.${choice}`)}
            </MenuItem>
          ))}
        </MenuSub>
      ) : (
        <>
          <MenuLabel>
            {t('deepWork.left', { until: format.absolute(until), count: deepWork.minutesLeft() })}
          </MenuLabel>
          <MenuItem glyph="deep-work" onSelect={deepWork.end}>
            {t('deepWork.stop')}
          </MenuItem>
        </>
      )}
      <MenuSeparator />
    </>
  );
};

/** Who you are, at the head of the menu: not a choice, so a label, which a screen reader reads. */
const Identity = ({
  name,
  username,
  online,
}: {
  readonly name: string;
  readonly username: string;
  readonly online: boolean | undefined;
}): React.JSX.Element => (
  <div className="flex items-center gap-3 px-2 pt-2 pb-3">
    <Avatar size="lg" name={name} username={username} online={online} />
    <div className="min-w-0 flex-1">
      <div className="truncate text-label font-semibold text-ink">{name}</div>
      <div className="truncate font-mono text-caption text-ink-muted">{`@${username}`}</div>
    </div>
  </div>
);

export const AccountMenu = (): React.JSX.Element => {
  const { t } = useI18n();
  const { user } = useSession();
  const { workspace } = useWorkspace();
  const { navigate } = useRoute();
  const leave = useSignOut();
  const openShortcuts = useShortcutsDoor();
  const mod = useMemo(() => keyLabels(isMacPlatform(navigator)).mod, []);
  const online = useOnline(user.id, user.id);

  return (
    <Menu
      side="top"
      align="start"
      trigger={
        <button
          type="button"
          className="flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors duration-hover ease-standard hover:bg-nav-hover data-[state=open]:bg-nav-hover max-narrow:min-h-touch"
        >
          {/* Named by what it shows, with what it is said before it: the name holds the visible text,
              so a person who says what they see reaches it (WCAG 2.5.3, label in name). */}
          <VisuallyHidden>{t('user.menuFor')}</VisuallyHidden>
          <Avatar size="md" name={user.displayName} username={user.username} online={online} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-label font-semibold text-nav-ink">
              {user.displayName}
            </span>
            <span className="block truncate font-mono text-caption text-nav-ink-muted">
              {`@${user.username}`}
            </span>
          </span>
          {/* The dot is decorative; this is what it says (D-136). */}
          {online === true ? <VisuallyHidden>{`, ${t('presence.online')}`}</VisuallyHidden> : null}
          <span className="text-nav-ink-muted">
            <Icon name="switch" />
          </span>
        </button>
      }
    >
      <Identity name={user.displayName} username={user.username} online={online} />
      <MenuSeparator />
      <DeepWorkItems />
      <MenuItem
        glyph="settings"
        shortcut={`${mod},`}
        onSelect={() => {
          navigate(href('settings', { slug: workspace.slug, section: 'profile' }));
        }}
      >
        {t('settings.label')}
      </MenuItem>
      {openShortcuts === null ? null : (
        <MenuItem glyph="shortcuts" shortcut={`${mod}/`} onSelect={openShortcuts}>
          {t('shortcuts.title')}
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem
        glyph="sign-out"
        onSelect={() => {
          leave('here');
        }}
      >
        {t('user.signOut')}
      </MenuItem>
    </Menu>
  );
};
