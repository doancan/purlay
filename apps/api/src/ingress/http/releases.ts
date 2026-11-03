/** The version this server runs and the newest release, for whoever is signed in (D-248). */
import type { LatestReleaseAnswer } from '@purlay/types';
import type { Auth } from '../../modules/auth/better-auth';
import type { ReleaseCheck } from '../../features/chat/integrations/latest-release';
import { SERVER_VERSION } from '../../platform/server-version';
import { requireSession } from './session';

/**
 * `GET /api/releases/latest` — any signed-in person; the check keeps what it learned for everybody. The version
 * is answered whatever the check could learn, so the browser need not ask the public `GET /api/client`, which
 * is charged to the client's address with the sign-in traffic (D-248).
 */
export const readLatestRelease = async (
  dependencies: { readonly auth: Auth; readonly releases: ReleaseCheck },
  request: Request,
): Promise<LatestReleaseAnswer> => {
  await requireSession(dependencies.auth, request);
  return { current: SERVER_VERSION, ...(await dependencies.releases.latest()) };
};
