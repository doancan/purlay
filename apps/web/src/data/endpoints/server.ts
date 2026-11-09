// The server itself: who it admits, what it runs, whether it is open to setup.
import { InstanceInfo, LatestReleaseAnswer, OwnAdmission } from '@purlay/types';
import { Type, type Static } from '@sinclair/typebox';
import type { Http } from '../http';
import { options } from './request';

/**
 * `GET /setup/status` (`SetupStatus`, `API.md` §2): whether this server is open to setup, and the address
 * it is configured for. The only setup call the main chunk makes — `/` goes to the wizard on a fresh
 * server — so its schema is here and the wizard's other calls are in the wizard's own chunk.
 */
const SetupStatusAnswer = Type.Object({ open: Type.Boolean(), appUrl: Type.String() });
export type SetupStatusAnswer = Static<typeof SetupStatusAnswer>;

export interface ServerApi {
  readonly ownAdmission: (signal?: AbortSignal) => Promise<OwnAdmission>;
  readonly instanceInfo: (signal?: AbortSignal) => Promise<InstanceInfo>;
  /** The version this server runs and the newest release as it could learn it; `latest` is null when it could not (D-248). */
  readonly latestRelease: (signal?: AbortSignal) => Promise<LatestReleaseAnswer>;
  /** Whether the server is open to setup, and the address it is configured for (D-179 §4). */
  readonly setupStatus: (signal?: AbortSignal) => Promise<SetupStatusAnswer>;
}

export const createServerApi = (http: Http): ServerApi => ({
  ownAdmission: (signal) =>
    http.request('GET', '/api/admission', OwnAdmission, options({}, signal)),
  instanceInfo: (signal) => http.request('GET', '/api/instance', InstanceInfo, options({}, signal)),
  latestRelease: (signal) =>
    http.request('GET', '/api/releases/latest', LatestReleaseAnswer, options({}, signal)),
  setupStatus: (signal) =>
    http.request('GET', '/setup/status', SetupStatusAnswer, options({}, signal)),
});
