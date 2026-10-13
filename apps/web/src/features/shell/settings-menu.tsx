/**
 * The person's preferences: the theme, the language and the shortcut reference (D-110), as menu
 * items. They live in the account menu at the sidebar's foot (D-124), and the gallery — which has
 * no account — wraps the same items in a Settings menu of its own, so there is one list of them.
 *
 * Items in a menu rather than three buttons, because none of them is used often and each used to
 * cost the sidebar a permanent control. The theme and the language stay radio groups — each is one
 * setting with one value, which is what `menuitemradio` says to a screen reader — and "System"
 * is still listed first, as the default a person who never opens this is already on. Each
 * language is named in itself, so somebody who landed in one they cannot read finds their own.
 *
 * The shortcut reference is the same overlay `Cmd/Ctrl+/` opens. Where nothing renders that
 * overlay (a screen mounted alone) the item is not drawn, rather than drawn and doing nothing.
 */
import { useMemo } from 'react';
import { useI18n } from '../../i18n/i18n-provider';
import { parseLocale } from '../../i18n/locale';
import { LOCALES } from '../../i18n/types';
import { THEME_CHOICES, parseChoice } from '../../theme/theme';
import { useTheme } from '../../theme/theme-provider';
import { IconButton } from '../../ui/icon-button';
import {
  Menu,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from '../../ui/menu';
import { isMacPlatform, keyLabels, type PlatformSource } from '../shortcuts/platform';
import { useShortcutsDoor } from './overlay';

interface PreferencesProps {
  /** What to read the platform from; the browser's `navigator` when absent. */
  readonly platform?: PlatformSource;
}

export const PreferenceItems = ({ platform }: PreferencesProps): React.JSX.Element => {
  const { t, locale, setLocale } = useI18n();
  const { choice, setChoice } = useTheme();
  const openShortcuts = useShortcutsDoor();
  const mod = useMemo(() => keyLabels(isMacPlatform(platform ?? navigator)).mod, [platform]);
  return (
    <>
      <MenuLabel>{t('theme.label')}</MenuLabel>
      <MenuRadioGroup
        value={choice}
        onValueChange={(value) => {
          setChoice(parseChoice(value));
        }}
      >
        {THEME_CHOICES.map((option) => (
          <MenuRadioItem key={option} value={option} glyph={option}>
            {t(`theme.${option}`)}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
      <MenuSeparator />
      <MenuLabel>{t('language.label')}</MenuLabel>
      <MenuRadioGroup
        value={locale}
        onValueChange={(value) => {
          const next = parseLocale(value);
          if (next !== null) setLocale(next);
        }}
      >
        {LOCALES.map((option) => (
          <MenuRadioItem key={option} value={option}>
            {t(`language.${option}`)}
          </MenuRadioItem>
        ))}
      </MenuRadioGroup>
      {openShortcuts === null ? null : (
        <>
          <MenuSeparator />
          <MenuItem glyph="shortcuts" shortcut={`${mod}/`} onSelect={openShortcuts}>
            {t('shortcuts.title')}
          </MenuItem>
        </>
      )}
    </>
  );
};

/** The preferences behind a button of their own, for a page with no account to hang them on. */
export const SettingsMenu = ({ platform }: PreferencesProps): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <Menu
      align="start"
      side="right"
      trigger={<IconButton label={t('settings.label')} glyph="settings" size="rail" />}
    >
      <PreferenceItems {...(platform === undefined ? {} : { platform })} />
    </Menu>
  );
};
