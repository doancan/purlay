/** Old bookmarks reach global administration even when the workspace no longer exists. */
import { useEffect } from 'react';
import { useRoute } from '../../router/router-provider';
import { href } from '../../router/routes';
import { useSession } from '../session/session';
import { NotFound } from '../shell/not-found';

export const LegacyServerRedirect = (): React.JSX.Element => {
  const { navigate } = useRoute();
  const { isServerAdmin } = useSession();
  useEffect(() => {
    if (isServerAdmin) navigate(href('serverHome'), { replace: true });
  }, [isServerAdmin, navigate]);
  return isServerAdmin ? <></> : <NotFound />;
};
