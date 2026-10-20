/**
 * Preferences (D-146): how Purlay looks and speaks on this device — the theme and the language, each a
 * set of choices shown at once and applied as one is chosen. Both are kept per device (D-41, D-98),
 * which the page says, so nobody expects their phone to follow their laptop.
 */
import { useI18n } from '../../../i18n/i18n-provider';
import { LOCALES } from '../../../i18n/types';
import { THEME_CHOICES } from '../../../theme/theme';
import { useTheme } from '../../../theme/theme-provider';
import { Choices } from '../choices';
import { SettingsCard, SettingsPage, SettingsRow } from '../page';

export const PreferencesPage = (): React.JSX.Element => {
  const { t, locale, setLocale } = useI18n();
  const { choice, setChoice } = useTheme();
  return (
    <SettingsPage
      title={t('settings.preferences.title')}
      description={t('settings.preferences.description')}
    >
      <SettingsCard
        title={t('settings.preferences.appearance')}
        description={t('settings.preferences.deviceHint')}
      >
        <SettingsRow
          label={t('theme.label')}
          description={t('settings.preferences.themeHint')}
          wide
        >
          <Choices
            label={t('theme.label')}
            value={choice}
            onChange={setChoice}
            choices={THEME_CHOICES.map((option) => ({
              value: option,
              label: t(`theme.${option}`),
              glyph: option,
            }))}
          />
        </SettingsRow>
        <SettingsRow
          label={t('language.label')}
          description={t('settings.preferences.languageHint')}
          wide
        >
          <Choices
            label={t('language.label')}
            value={locale}
            onChange={setLocale}
            choices={LOCALES.map((option) => ({
              value: option,
              label: t(`language.${option}`),
              glyph: 'language',
            }))}
          />
        </SettingsRow>
      </SettingsCard>
    </SettingsPage>
  );
};
