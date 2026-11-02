/**
 * Administration → Server's calls (`API.md` §2, `/api/server/*`), in the settings' chunk.
 *
 * Like the wizard's client, and for the same reasons: the answers are plain types (no schema lands in the
 * bundle), a failure is a `SetupFailure` — whose `reason` carries a refusal's `details.reason` — and
 * `fetch` is an argument, so a test answers with whatever it likes. It shares the wizard's caller and its
 * guards, so the probe's answer is read exactly as the wizard reads it.
 */
import type {
  ProbeResult,
  ServerAccount,
  ServerGitHubAppRequest,
  ServerPolicyRequest,
  ServerSettingsAnswer,
} from '@purlay/types';
import { isProbeResult, isRecord, jsonCaller, malformed, type SetupFetch } from '../setup/client';

interface RelayTry {
  readonly smtpUrl: string;
  readonly from: string;
  readonly allowPlaintext: boolean;
}

export type CreatorsChoice =
  | { readonly kind: 'first' | 'anyone' }
  | { readonly kind: 'listed'; readonly logins: readonly string[] };

export interface ServerClient {
  readonly settings: (signal?: AbortSignal) => Promise<ServerSettingsAnswer>;
  readonly github: (candidate: {
    readonly clientId: string;
    readonly clientSecret: string;
  }) => Promise<ProbeResult>;
  readonly oidc: (candidate: {
    readonly issuer: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly name: string;
  }) => Promise<ProbeResult>;
  readonly smtp: (candidate: RelayTry) => Promise<ProbeResult>;
  /** The GitHub App issues are written through (D-246): tried as its client and as itself, kept if both hold. */
  readonly githubApp: (candidate: ServerGitHubAppRequest) => Promise<ProbeResult>;
  readonly disconnect: (
    channel: 'github' | 'smtp' | 'oidc' | 'github-app',
    confirmLastChannel: boolean,
  ) => Promise<void>;
  /** One rule of the sign-in policy: who may make an account, two-step verification, passwords (D-239). */
  readonly policy: (change: ServerPolicyRequest) => Promise<void>;
  readonly creators: (workspaceCreators: CreatorsChoice) => Promise<void>;
  /** Accounts found by name, username or address (D-233). */
  readonly accounts: (words: string, signal?: AbortSignal) => Promise<readonly ServerAccount[]>;
  readonly suspend: (userId: string) => Promise<void>;
  readonly lift: (userId: string) => Promise<void>;
}

const isAccount = (value: unknown): value is ServerAccount =>
  isRecord(value) &&
  typeof value['id'] === 'string' &&
  typeof value['username'] === 'string' &&
  typeof value['displayName'] === 'string' &&
  (value['email'] === null || typeof value['email'] === 'string') &&
  typeof value['isServerAdmin'] === 'boolean' &&
  (value['suspendedAt'] === null || typeof value['suspendedAt'] === 'string');

const isAnswer = (value: unknown): value is ServerSettingsAnswer =>
  isRecord(value) &&
  isRecord(value['settings']) &&
  Array.isArray(value['needsReentry']) &&
  typeof value['appUrl'] === 'string' &&
  typeof value['githubCallbackUrl'] === 'string' &&
  typeof value['oidcCallbackUrl'] === 'string' &&
  isRecord(value['githubApp']) &&
  typeof value['githubApp']['callbackUrl'] === 'string' &&
  typeof value['githubApp']['webhookUrl'] === 'string' &&
  isRecord(value['channels']) &&
  typeof value['channels']['github'] === 'boolean' &&
  typeof value['channels']['email'] === 'boolean' &&
  typeof value['channels']['oidc'] === 'boolean' &&
  typeof value['adminEmail'] === 'string';

export const createServerClient = (fetchFn: SetupFetch): ServerClient => {
  const call = jsonCaller(fetchFn);
  const probe = async (path: string, body: unknown): Promise<ProbeResult> => {
    const { status, json } = await call('POST', path, body);
    if (!isProbeResult(json)) throw malformed(status);
    return json;
  };
  return {
    settings: async (signal): Promise<ServerSettingsAnswer> => {
      const { status, json } = await call('GET', '/api/server/settings', undefined, signal);
      if (!isAnswer(json)) throw malformed(status);
      return json;
    },
    github: (candidate) => probe('/api/server/github', candidate),
    oidc: (candidate) => probe('/api/server/oidc', candidate),
    smtp: (candidate) => probe('/api/server/smtp', candidate),
    githubApp: (candidate) => probe('/api/server/github-app', candidate),
    disconnect: async (channel, confirmLastChannel): Promise<void> => {
      await call(
        'DELETE',
        `/api/server/${channel}`,
        confirmLastChannel ? { confirmLastChannel: true } : undefined,
      );
    },
    policy: async (change): Promise<void> => {
      await call('POST', '/api/server/policy', change);
    },
    creators: async (workspaceCreators): Promise<void> => {
      await call('POST', '/api/server/creators', { workspaceCreators });
    },
    accounts: async (words, signal): Promise<readonly ServerAccount[]> => {
      const query = words === '' ? '' : `?q=${encodeURIComponent(words)}`;
      const { status, json } = await call('GET', `/api/server/accounts${query}`, undefined, signal);
      if (!Array.isArray(json) || !json.every(isAccount)) throw malformed(status);
      return json;
    },
    suspend: async (userId): Promise<void> => {
      await call('PUT', `/api/server/accounts/${encodeURIComponent(userId)}/suspension`);
    },
    lift: async (userId): Promise<void> => {
      await call('DELETE', `/api/server/accounts/${encodeURIComponent(userId)}/suspension`);
    },
  };
};
