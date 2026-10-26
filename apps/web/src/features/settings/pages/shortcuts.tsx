/**
 * Keyboard shortcuts (D-146): the same reference `Cmd/Ctrl+/` opens, as a page — each group a card, so
 * it reads like the rest of the settings and can be linked to.
 */
import { useMemo } from 'react';
import { useI18n } from '../../../i18n/i18n-provider';
import { isMacPlatform } from '../../shortcuts/platform';
import { ShortcutList } from '../../shortcuts/shortcuts-dialog';
import { SettingsCard, SettingsPage } from '../page';

export const ShortcutsPage = (): React.JSX.Element => {
  const { t } = useI18n();
  const mac = useMemo(() => isMacPlatform(navigator), []);
  return (
    <SettingsPage title={t('shortcuts.title')} description={t('shortcuts.description')}>
      <SettingsCard>
        {/* Static words, in a page that scrolls: a keyboard reaches them by a stop of their own, or cannot scroll them. */}
        <div
          role="region"
          aria-label={t('shortcuts.title')}
          tabIndex={0}
          className="flex flex-col gap-6 px-6 py-5 max-narrow:px-4"
        >
          <ShortcutList mac={mac} level={2} />
        </div>
      </SettingsCard>
    </SettingsPage>
  );
};
