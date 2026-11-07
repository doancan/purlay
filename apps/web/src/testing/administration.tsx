import type { Api } from '../data/api';
/** Real administration screens and clients; only HTTP answers and the signed-in world are fixtures. */
import type {
  InstanceInfo,
  ServerOverview,
  ServerSettingsAnswer,
  ServerUser,
  ServerWorkspace,
} from '@purlay/types';
import { Outlet } from '../app/outlet';
import { createAdministrationClient } from '../features/administration/client';
import { AdministrationClientProvider } from '../features/administration/context';
import { createServerClient } from '../features/settings/server-client';
import { ServerClientProvider } from '../features/settings/server-context';
import { aSession, aSignedInApi } from './fixtures';
import { renderApp } from './render';

export const ADMIN_STAMP = '2026-11-06T08:00:00.000Z';
export const ADMIN_USER: ServerUser = {
  id: aSession().user.id,
  username: 'ada',
  displayName: 'Ada Lovelace',
  email: 'ada@example.test',
  emailVerified: true,
  isServerAdmin: false,
  admissionState: 'approved',
  createdAt: ADMIN_STAMP,
  lastSeenAt: null,
  suspendedAt: null,
};
export const ADMIN_WORKSPACE: ServerWorkspace = {
  id: ADMIN_USER.id,
  name: 'Research team',
  slug: 'research',
  createdAt: ADMIN_STAMP,
  deletedAt: null,
  purgedAt: null,
  memberCount: 4,
  ownerCount: 1,
  owners: [{ id: ADMIN_USER.id, displayName: ADMIN_USER.displayName }],
  usedBytes: '2048',
  quotaBytes: '4096',
  retentionDays: 30,
  modules: [],
};
export const ADMIN_PREFERENCES: InstanceInfo = {
  displayName: 'Purlay',
  supportUrl: null,
  allowedEmailDomains: [],
  requireAccountApproval: false,
};
export const ADMIN_OVERVIEW: ServerOverview = {
  checkedAt: ADMIN_STAMP,
  version: '0.3.0',
  appUrl: 'https://purlay.test',
  ready: true,
  modules: ['chat'],
  users: 12,
  admins: 2,
  suspendedUsers: 1,
  workspaces: 3,
  deletedWorkspaces: 0,
  usedBytes: '1024',
  storage: 's3',
  pushConfigured: false,
  sharedStateConfigured: false,
  exportFailures: 0,
};
export const ADMIN_SETTINGS: ServerSettingsAnswer = {
  settings: {
    signUp: 'invite-only',
    requireTwoFactor: false,
    passwordSignIn: true,
    sessionIdleTimeoutHours: null,
    sessionMaxAgeDays: null,
    github: null,
    oidc: null,
    google: null,
    smtp: null,
    githubApp: null,
    workspaceCreators: { kind: 'first' },
    setupCompletedAt: ADMIN_STAMP,
  },
  needsReentry: [],
  appUrl: 'https://purlay.test',
  githubCallbackUrl: 'https://purlay.test/auth/callback/github',
  oidcCallbackUrl: 'https://purlay.test/auth/callback/oidc',
  googleCallbackUrl: 'https://purlay.test/auth/callback/google',
  githubApp: {
    callbackUrl: 'https://purlay.test/api/github-app/callback',
    webhookUrl: 'https://purlay.test/api/webhooks/github-app',
  },
  channels: { github: false, email: false, oidc: false, google: false },
  adminEmail: 'admin@example.test',
};
export interface AdministrationCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly signal?: AbortSignal;
}
export const adminJson = (value: unknown, status = 200): Response =>
  Response.json(value, { status });
export const adminError = (): Response =>
  adminJson({ error: { code: 'INTERNAL', message: 'Unavailable' } }, 500);
export const renderAdministration = async (
  section: string,
  answer: (call: AdministrationCall) => Response | undefined = () => undefined,
  options: {
    readonly modules?: ('chat' | 'issues')[];
    readonly api?: Partial<Api>;
    readonly settings?: ServerSettingsAnswer;
  } = {},
): Promise<Awaited<ReturnType<typeof renderApp>> & { calls: AdministrationCall[] }> => {
  const calls: AdministrationCall[] = [];
  const fetchFn = (path: string, init: RequestInit): Promise<Response> => {
    const call = {
      path,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      ...(init.signal == null ? {} : { signal: init.signal }),
    };
    calls.push(call);
    const custom = answer(call);
    if (custom !== undefined) return Promise.resolve(custom);
    if (call.method !== 'GET') return Promise.resolve(new Response(null, { status: 204 }));
    const pathname = new URL(path, 'https://purlay.test').pathname;
    const value =
      pathname === '/api/server/preferences'
        ? ADMIN_PREFERENCES
        : pathname === '/api/server/settings'
          ? (options.settings ?? ADMIN_SETTINGS)
          : pathname === '/api/server/overview'
            ? ADMIN_OVERVIEW
            : pathname === '/api/server/operations'
              ? { checkedAt: ADMIN_STAMP, staleAfterMs: 172800000, jobs: [] }
              : pathname === '/api/server/mail-test'
                ? { lastTest: null }
                : pathname === '/api/server/backups'
                  ? {
                      state: 'unconfigured',
                      checkedAt: ADMIN_STAMP,
                      backup: null,
                      restore: null,
                      restoreMatchesLatest: false,
                    }
                  : { data: [], nextCursor: null };
    return Promise.resolve(adminJson(value));
  };
  const client = createAdministrationClient(fetchFn);
  const providers = createServerClient(fetchFn);
  const session = aSession();
  const view = await renderApp(
    <AdministrationClientProvider value={client}>
      <ServerClientProvider value={providers}>
        <Outlet />
      </ServerClientProvider>
    </AdministrationClientProvider>,
    {
      path: `/server/${section}`,
      api: aSignedInApi({
        me: () =>
          Promise.resolve({
            ...session,
            isServerAdmin: true,
            modules: options.modules ?? ['chat'],
            memberships: [],
          }),
        ...options.api,
      }),
    },
  );
  return Object.assign(view, { calls });
};
