/**
 * "Continue with GitHub": a link to `/auth/github` (`ProviderButton`).
 */
import { useI18n } from '../../i18n/i18n-provider';
import { ProviderButton, type ProviderButtonProps } from './provider-button';

export const GitHubButton = (props: ProviderButtonProps): React.JSX.Element => {
  const { t } = useI18n();
  return <ProviderButton href="/auth/github" icon="github" label={t('signIn.github')} {...props} />;
};
