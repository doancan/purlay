/**
 * The language picker.
 *
 * Each language is named in itself ("Türkçe", never "Turkish"): a person who
 * landed in a language they cannot read must be able to find their own. The names
 * are catalogue entries only so the picker is one list; they are the same in every
 * catalogue on purpose.
 */
import { IconButton } from '../ui/icon-button';
import { Menu, MenuLabel, MenuRadioGroup, MenuRadioItem } from '../ui/menu';
import { useI18n } from './i18n-provider';
import { parseLocale } from './locale';
import { LOCALES } from './types';

export const LanguageMenu = (): React.JSX.Element => {
  const { t, locale, setLocale } = useI18n();
  return (
    <Menu align="end" trigger={<IconButton label={t('language.label')} glyph="language" />}>
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
    </Menu>
  );
};
