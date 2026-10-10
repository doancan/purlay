/** An address that leads nowhere the person may go; one screen for every reason, as the API's 404 is. */
import { useI18n } from '../../i18n/i18n-provider';
import { Link } from '../../router/router-provider';
import { buttonStyle } from '../../ui/button';
import { Main } from '../../ui/main';
import { EmptyState } from '../../ui/states';

export const NotFound = (): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <Main className="min-h-screen bg-surface-100 text-ink">
      <EmptyState
        as="h1"
        title={t('app.notFound.title')}
        body={t('app.notFound.body')}
        action={
          <Link to="home" className={buttonStyle('primary')}>
            {t('app.notFound.home')}
          </Link>
        }
      />
    </Main>
  );
};
