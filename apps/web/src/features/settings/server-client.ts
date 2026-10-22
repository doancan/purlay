/**
 * Administration → Server's calls (`API.md` §2, `/api/server/*`), in the settings' chunk.
 *
 * Like the wizard's client, and for the same reasons: the answers are plain types (no schema lands in the
 * bundle), a failure is a `SetupFailure` — whose `reason` carries a refusal's `details.reason` — and
 * `fetch` is an argument, so a test answers with whatever it likes. It shares the wizard's caller and its
 * guards, so the probe's answer is read exactly as the wizard reads it.
 */
import type { ProbeResult, ServerSettingsAnswer } from '@purlay/types';
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
  readonly smtp: (candidate: RelayTry) => Promise<ProbeResult>;
  readonly disconnect: (channel: 'github' | 'smtp', confirmLastChannel: boolean) => Promise<void>;
  readonly policy: (signUp: 'invite-only' | 'open') => Promise<void>;
  readonly creators: (workspaceCreators: CreatorsChoice) => Promise<void>;
}

const isAnswer = (value: unknown): value is ServerSettingsAnswer =>
  isRecord(value) &&
  isRecord(value['settings']) &&
  Array.isArray(value['needsReentry']) &&
  typeof value['appUrl'] === 'string' &&
  typeof value['githubCallbackUrl'] === 'string' &&
  isRecord(value['channels']) &&
  typeof value['channels']['github'] === 'boolean' &&
  typeof value['channels']['email'] === 'boolean' &&
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
    smtp: (candidate) => probe('/api/server/smtp', candidate),
    disconnect: async (channel, confirmLastChannel): Promise<void> => {
      await call(
        'DELETE',
        `/api/server/${channel}`,
        confirmLastChannel ? { confirmLastChannel: true } : undefined,
      );
    },
    policy: async (signUp): Promise<void> => {
      await call('POST', '/api/server/policy', { signUp });
    },
    creators: async (workspaceCreators): Promise<void> => {
      await call('POST', '/api/server/creators', { workspaceCreators });
    },
  };
};
