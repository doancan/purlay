/**
 * "Continue with Google": a link to `/auth/google` (`ProviderButton`), marked with Google's own "G" (D-250 §9).
 */
import { GOOGLE_START_PATH } from '@purlay/types';
import { useI18n } from '../../i18n/i18n-provider';
import { ProviderButton, type ProviderButtonProps } from './provider-button';

export const GoogleButton = (props: ProviderButtonProps): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <ProviderButton href={GOOGLE_START_PATH} icon="google" label={t('signIn.google')} {...props} />
  );
};
