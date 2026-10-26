/**
 * What a client that is not a browser asks before anybody signs in (`GET /api/client`, D-186): which
 * server this is, which wire contract it speaks, the one address its socket's `Origin` must be, the
 * minimum an installed client has to meet, and how people sign in here — so one call draws the
 * sign-in screen and says whether the application may go on.
 *
 * Nothing of anybody is in it, and it reads no database: the same for every caller.
 */
import { CONTRACT_VERSION, type ClientInfo } from '@purlay/types';
import type { Auth } from '../../modules/auth/better-auth';
import type { Config } from '../../platform/config';
import { SERVER_VERSION } from '../../platform/server-version';
import { authMethods } from './auth-methods';
import type { ClientPolicy } from './client-policy';

/** What the operator set for the clients that are installed, as the edge reads it. */
export const clientPolicyOf = (config: Config): ClientPolicy => ({
  macos: {
    contract: config.MIN_CLIENT_MACOS_CONTRACT ?? null,
    version: config.MIN_CLIENT_MACOS_VERSION ?? null,
    downloadUrl: config.MACOS_DOWNLOAD_URL ?? null,
  },
});

export const clientInfo = (
  config: Config,
  auth: Pick<Auth, 'signInLinks' | 'github' | 'signUp'>,
): ClientInfo => {
  const { macos } = clientPolicyOf(config);
  return {
    server: { version: SERVER_VERSION },
    contractVersion: CONTRACT_VERSION,
    appUrl: config.APP_URL,
    minClient: {
      macos: {
        contractVersion: macos.contract,
        appVersion: macos.version,
        downloadUrl: macos.downloadUrl,
      },
    },
    auth: authMethods(auth),
  };
};
