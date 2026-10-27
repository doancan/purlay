/**
 * "Continue with <name>": a link to `/auth/oidc` (`ProviderButton`), where the server has a single sign-on
 * provider connected (D-200). The name is the operator's own label for it, shown as text — never as markup —
 * or, where they gave none, a default in the person's language.
 */
import { useI18n } from '../../i18n/i18n-provider';
import { ProviderButton, type ProviderButtonProps } from './provider-button';

export const OidcButton = ({
  name,
  ...props
}: ProviderButtonProps & {
  /** `AuthMethods.oidc.name`: the operator's label, or `null` for the default. */
  readonly name: string | null;
}): React.JSX.Element => {
  const { t } = useI18n();
  return (
    <ProviderButton
      href="/auth/oidc"
      icon="lock"
      label={t('signIn.oidc', { name: name ?? t('signIn.oidc.default') })}
      {...props}
    />
  );
};
