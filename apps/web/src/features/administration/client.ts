import { Value } from '@sinclair/typebox/value';
import type { Static, TSchema } from '@sinclair/typebox';
import {
  ServerBackupStatus,
  ServerPreferences,
  type ServerPreferencesRequest,
  ServerMailStatus,
  ServerMailTest,
  ServerAuditPage,
  ServerOperations,
  ServerOverview,
  ServerUserDetail,
  ServerUserPage,
  ServerWorkspacePage,
  type ServerAuditQuery,
  type ServerUsersQuery,
  type ServerWorkspacesQuery,
} from '@purlay/types';
import { jsonCaller, malformed, type SetupFetch } from '../setup/client';

const queryString = (values: Readonly<Record<string, string | number | undefined>>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined && value !== '') search.set(key, String(value));
  return search.toString();
};
export const createAdministrationClient = (
  fetchFn: SetupFetch,
): {
  backups: (signal?: AbortSignal) => Promise<ServerBackupStatus>;
  preferences: (signal?: AbortSignal) => Promise<ServerPreferences>;
  savePreferences: (input: ServerPreferencesRequest) => Promise<void>;
  admission: (id: string, decision: 'approved' | 'denied') => Promise<void>;
  mailStatus: (signal?: AbortSignal) => Promise<ServerMailStatus>;
  testMail: () => Promise<ServerMailTest>;
  overview: (signal?: AbortSignal) => Promise<ServerOverview>;
  operations: (signal?: AbortSignal) => Promise<ServerOperations>;
  users: (query: ServerUsersQuery, signal?: AbortSignal) => Promise<ServerUserPage>;
  user: (id: string, after?: string, signal?: AbortSignal) => Promise<ServerUserDetail>;
  workspaces: (query: ServerWorkspacesQuery, signal?: AbortSignal) => Promise<ServerWorkspacePage>;
  audit: (query: ServerAuditQuery, signal?: AbortSignal) => Promise<ServerAuditPage>;
  role: (id: string, isServerAdmin: boolean) => Promise<void>;
  revokeSessions: (id: string) => Promise<void>;
  quota: (id: string, quotaBytes: number) => Promise<void>;
} => {
  const call = jsonCaller(fetchFn);
  const read = async <S extends TSchema>(
    path: string,
    schema: S,
    signal?: AbortSignal,
  ): Promise<Static<S>> => {
    const { status, json } = await call('GET', path, undefined, signal);
    if (!Value.Check(schema, json)) throw malformed(status);
    return json;
  };
  const write = async (path: string, body: unknown): Promise<void> => {
    await call('POST', path, body);
  };
  return {
    backups: async (signal) => await read('/api/server/backups', ServerBackupStatus, signal),
    preferences: async (signal) => await read('/api/server/preferences', ServerPreferences, signal),
    savePreferences: async (input): Promise<void> => {
      await write('/api/server/preferences', input);
    },
    admission: async (id, decision): Promise<void> => {
      await write(`/api/server/users/${encodeURIComponent(id)}/admission`, { decision });
    },
    mailStatus: async (signal) => await read('/api/server/mail-test', ServerMailStatus, signal),
    testMail: async (): Promise<ServerMailTest> => {
      const { status, json } = await call('POST', '/api/server/mail-test', {});
      if (!Value.Check(ServerMailTest, json)) throw malformed(status);
      return json;
    },
    overview: async (signal) => await read('/api/server/overview', ServerOverview, signal),
    operations: async (signal) => await read('/api/server/operations', ServerOperations, signal),
    users: async (query, signal) =>
      await read(`/api/server/users?${queryString(query)}`, ServerUserPage, signal),
    user: async (id, after, signal) =>
      await read(
        `/api/server/users/${encodeURIComponent(id)}?${queryString({ after })}`,
        ServerUserDetail,
        signal,
      ),
    workspaces: async (query, signal) =>
      await read(`/api/server/workspaces?${queryString(query)}`, ServerWorkspacePage, signal),
    audit: async (query, signal) =>
      await read(`/api/server/audit?${queryString(query)}`, ServerAuditPage, signal),
    role: async (id, isServerAdmin): Promise<void> => {
      await write(`/api/server/users/${encodeURIComponent(id)}/admin`, { isServerAdmin });
    },
    revokeSessions: async (id): Promise<void> => {
      await write(`/api/server/users/${encodeURIComponent(id)}/revoke-sessions`, {});
    },
    quota: async (id, quotaBytes): Promise<void> => {
      await write(`/api/server/workspaces/${encodeURIComponent(id)}/quota`, { quotaBytes });
    },
  };
};
