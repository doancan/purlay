/** An address that leads nowhere the person may go; one screen for every reason, as the API's 404 is. */
import { useI18n } from '../../i18n/i18n-provider';
import { Link } from '../../router/router-provider';
import { buttonStyle } from '../../ui/button';
import { Main } from '../../ui/main';
import { Notice } from './notice';

export const NotFound = (): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <Main className="flex min-h-screen flex-col bg-surface-100 text-ink">
      <div className="flex flex-1 flex-col">
        <Notice
          as="h1"
          glyph="info"
          title={t('app.notFound.title')}
          body={t('app.notFound.body')}
          action={
            <Link to="home" className={buttonStyle('primary')}>
              {t('app.notFound.home')}
            </Link>
          }
        />
      </div>
    </Main>
  );
};
