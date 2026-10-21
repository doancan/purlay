/**
 * The account menu, from the sidebar's foot: who you are, and what you reach for often (D-124,
 * D-146) — Deep Work, Settings, the shortcut reference, and signing out. Everything else that is the
 * person's — the theme, the language, this device's notifications, signing out everywhere and erasing
 * the account — is a page of Settings, where it has room to say what it does.
 *
 * - **Deep Work** is started for a while chosen here — half an hour, one, two, or until tomorrow
 *   morning — and the instant is what the server is sent, so it is the server's delivery that stops
 *   (D-15, D-108). On, it says until when and how long is left, and offers its end.
 * - **Settings** opens the person's Profile page; `Cmd/Ctrl+,` opens it from anywhere.
 */
import { useMemo } from 'react';
import { Icon } from '../../components/icon';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { Avatar } from '../../ui/avatar';
import { Menu, MenuItem, MenuLabel, MenuSeparator } from '../../ui/menu';
import { useSession } from '../session/session';
import { isMacPlatform, keyLabels } from '../shortcuts/platform';
import { DEEP_WORK_CHOICES, useDeepWorkControls } from './deep-work';
import { useShortcutsDoor } from './overlay';
import { useSignOut } from './sign-out';
import { useWorkspace } from './workspace';
import { VisuallyHidden } from '../../ui/visually-hidden';

/** Deep Work's part of the menu: the whiles to start it for, or how long is left and its end. */
const DeepWorkItems = (): React.JSX.Element | null => {
  const { t, format } = useI18n();
  const deepWork = useDeepWorkControls();
  if (deepWork === null) return null;
  const { until } = deepWork;
  return (
    <>
      <MenuLabel>
        {until === null
          ? t('deepWork.label')
          : t('deepWork.left', { until: format.absolute(until), count: deepWork.minutesLeft() })}
      </MenuLabel>
      {until === null ? (
        DEEP_WORK_CHOICES.map((choice) => (
          <MenuItem
            key={choice}
            glyph="deep-work"
            onSelect={() => {
              deepWork.start(choice);
            }}
          >
            {t(`deepWork.choice.${choice}`)}
          </MenuItem>
        ))
      ) : (
        <MenuItem glyph="deep-work" onSelect={deepWork.end}>
          {t('deepWork.stop')}
        </MenuItem>
      )}
      <MenuSeparator />
    </>
  );
};

export const AccountMenu = (): React.JSX.Element => {
  const { t } = useI18n();
  const { user } = useSession();
  const { workspace } = useWorkspace();
  const { navigate } = useRoute();
  const leave = useSignOut();
  const openShortcuts = useShortcutsDoor();
  const mod = useMemo(() => keyLabels(isMacPlatform(navigator)).mod, []);

  return (
    <Menu
      side="top"
      align="start"
      trigger={
        <button
          type="button"
          className="flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors duration-hover ease-standard hover:bg-nav-hover"
        >
          {/* Named by what it shows, with what it is said before it: the name holds the visible text,
              so a person who says what they see reaches it (WCAG 2.5.3, label in name). */}
          <VisuallyHidden>{t('user.menuFor')}</VisuallyHidden>
          <Avatar size="md" name={user.displayName} username={user.username} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-label font-semibold text-nav-ink">
              {user.displayName}
            </span>
            <span className="block truncate font-mono text-caption text-nav-ink-muted">
              {`@${user.username}`}
            </span>
          </span>
          <span className="text-nav-ink-muted">
            <Icon name="preferences" />
          </span>
        </button>
      }
    >
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
