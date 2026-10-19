/**
 * Signing out, here or everywhere (D-11, D-124): the one way both the account menu and Sessions &
 * account leave. Either forgets the page's cache and goes to the sign-in screen with `replace`, so
 * Back does not return to a page that would bounce; a refusal is a toast and the person stays signed
 * in, and told — going to the sign-in screen anyway would bounce straight back and look like nothing
 * happened.
 */
import { useActions } from '../../data/actions-provider';
import { useDescribeFailure } from '../../data/failure';
import { useI18n } from '../../i18n/i18n-provider';
import { href } from '../../router/routes';
import { useRoute } from '../../router/router-provider';
import { useToast } from '../../ui/toast';

export const useSignOut = (): ((scope: 'here' | 'everywhere') => void) => {
  const { t } = useI18n();
  const { signOut } = useActions();
  const { navigate } = useRoute();
  const { show } = useToast();
  const describe = useDescribeFailure();
  return (scope) => {
    void signOut(scope).then(
      () => {
        navigate(href('signIn'), { replace: true });
      },
      (error: unknown) => {
        show({ message: `${t('failure.signOut')} ${describe(error)}` });
      },
    );
  };
};
