/**
 * What a refused leave says, wherever it was asked (D-123): the channel's details and a sidebar row's
 * menu (D-165) alike. The last member of a private channel is told what to do instead; anything else
 * is said as every failure is.
 */
import { isApiError } from '../../data/errors';
import { useDescribeFailure } from '../../data/failure';
import { useI18n } from '../../i18n/i18n-provider';

export const useLeaveRefusal = (): ((failure: unknown) => string) => {
  const { t } = useI18n();
  const describe = useDescribeFailure();
  return (failure) =>
    isApiError(failure) && failure.code === 'LAST_CHANNEL_MEMBER'
      ? t('details.lastMember')
      : `${t('details.leaveFailed')} ${describe(failure)}`;
};
