/** The open-questions view. A stand-in the questions slice replaces. */
import { useI18n } from '../../i18n/i18n-provider';

export const QuestionsScreen = (): React.JSX.Element => {
  const { t } = useI18n();
  return <h1 className="p-4 text-title text-ink">{t('questions.title')}</h1>;
};
