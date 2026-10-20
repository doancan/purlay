/**
 * Data & retention (D-146): an owner's page for what the workspace keeps and what can leave it — how
 * much room its files take (D-173), how long history is kept (D-139 §4) and exports (D-140), each in a
 * card of its own.
 */
import { useI18n } from '../../../i18n/i18n-provider';
import { SettingsPage } from '../page';
import { ExportCard } from './export';
import { RetentionCard } from './retention';
import { StorageCard } from './storage';

export const DataPage = (): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <SettingsPage title={t('settings.data.title')} description={t('settings.data.description')}>
      <StorageCard />
      <RetentionCard />
      <ExportCard />
    </SettingsPage>
  );
};
