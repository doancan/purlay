/**
 * The theme picker: system, light or dark, one menu.
 *
 * The trigger shows the theme that is *showing* (sun or moon), not the choice,
 * so the icon is always a true picture of the screen; the menu shows the choice,
 * with a check beside it. "System" is a real option and listed first, because it
 * is the default and the one a person who never opens this menu is already on.
 *
 * Radio items, not buttons: the three are one setting with one value, which is
 * exactly what `menuitemradio` says to a screen reader.
 */
import { useI18n } from '../i18n/i18n-provider';
import { IconButton } from '../ui/icon-button';
import { Menu, MenuLabel, MenuRadioGroup, MenuRadioItem } from '../ui/menu';
import { THEME_CHOICES, parseChoice } from './theme';
import { useTheme } from './theme-provider';

export const ThemeMenu = (): React.JSX.Element => {
  const { t } = useI18n();
  const { choice, resolved, setChoice } = useTheme();
  return (
    <Menu align="end" trigger={<IconButton label={t('theme.label')} glyph={resolved} />}>
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
    </Menu>
  );
};
