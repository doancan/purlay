/**
 * Administration → Server (D-179 §4.8): the operator's settings changed in the browser after the setup,
 * by the server's administrator alone — every function here takes the `ServerAdminSession` that
 * `requireServerAdmin` mints, so none can be called without the guard.
 *
 * It is the wizard's own machinery, not a second one:
 *
 * - **Tried, then kept.** A GitHub app or a relay is tried with the candidate (`probeGitHub`,
 *   `probeSmtp`, under the administrator's authority) and saved and swapped in by `applySettings` only
 *   when the try worked. A try that failed saves nothing and says why, in the closed reasons the wizard
 *   says. The wizard's `tried` bookkeeping is **not** used and `canFinish` is never consulted: they
 *   exist for the finish rule of a setup that is open, and these routes refuse while it is
 *   (`setup-unfinished`), so a change made here cannot leave a wizard's flag describing a pair that is no
 *   longer the one that was probed.
 * - **The relay's test letter goes to the administrator's own address**, as a plain test: this is a
 *   change made by someone who is signed in, not the proof of an address.
 * - **Never the only way in by accident.** Disconnecting GitHub or the relay is refused when no other
 *   way for other people to sign in would remain, unless the administrator says so
 *   (`confirmLastChannel`). The rule is weighed inside the swap's own transaction, under its lock, from
 *   what that transaction saved — two disconnects at once cannot both pass it.
 * - **Never nobody's way in** (D-239). Password sign-in is turned off only while GitHub or single sign-on is
 *   connected, and the last of them is not disconnected while it is off — no confirmation lets it go. Both
 *   rules are weighed as the last way in is, inside the swap's transaction, from what that transaction saved:
 *   two administrators at once, one turning passwords off and one disconnecting the provider, cannot both pass.
 * - **Every change is on the trail** (`server_audit_log`), written in the transaction that saves it:
 *   who, which setting, never the value.
 */
import type { Executor, Transaction } from '@purlay/db';
import {
  OIDC_CALLBACK,
  SIGN_IN_CALLBACK,
  type ProbeResult,
  type ServerSettingsAnswer,
  type ServerCreatorsRequest,
  type ServerPolicyRequest,
} from '@purlay/types';
import type { Clock } from '../../platform/clock';
import {
  smtpTransport,
  textLetter,
  type MailMessage,
  type SmtpTransportFactory,
} from '../../platform/mail';
import { recordServerAudit, type ServerAuditAction } from '../audit/server-audit';
import type { SignInLocale } from '../auth/sign-in-letters';
import {
  candidateRefusal,
  GITHUB_PROBE_TIMEOUT_MS,
  probeGitHub,
  probeOidc,
  probeSmtp,
  SMTP_PROBE_TIMEOUT_MS,
  type GitHubProbeDependencies,
  type OidcProbeDependencies,
} from './probes';
import {
  applySettings,
  SettingsChangeFailed,
  type RuntimeServices,
  type SettingsChange,
} from './runtime';
import {
  readSettingsToBoot,
  settingsView,
  type ServerSettings,
  type SmtpSettings,
} from './settings';
import { setupStatus, type ServerAdminSession } from './setup';

/** What each way in being disconnected is called on the trail. */
const DISCONNECTED: Readonly<Record<'github' | 'smtp' | 'oidc', ServerAuditAction>> = {
  github: 'server.github_disconnected',
  smtp: 'server.smtp_disconnected',
  oidc: 'server.oidc_disconnected',
};

/** Why a change was refused beyond a failed swap (`409 SERVER_CHANGE_REFUSED`). */
export type ServerChangeRefusal =
  'last-channel' | 'not-connected' | 'setup-unfinished' | 'no-provider' | 'passwords-off';

const SENTENCES: Record<ServerChangeRefusal, string> = {
  'last-channel':
    'That would leave the administrator’s password as the only way to sign in. Say so to go ahead.',
  'not-connected': 'There is nothing of that kind connected.',
  'setup-unfinished': 'The setup is not finished yet; its steps change the settings until it is.',
  'no-provider':
    'Password sign-in can be turned off only while GitHub or single sign-on is connected.',
  'passwords-off':
    'Password sign-in is off, and this is the last of GitHub and single sign-on: nobody could sign in. Turn passwords on first.',
};

export class ServerChangeRefused extends Error {
  readonly reason: ServerChangeRefusal;

  constructor(reason: ServerChangeRefusal) {
    super(SENTENCES[reason]);
    this.name = 'ServerChangeRefused';
    this.reason = reason;
  }
}

export interface ServerAdminDependencies {
  readonly database: Executor;
  readonly clock: Clock;
  readonly change: SettingsChange;
}

/** Refused while the setup in the browser is open: its steps are how the settings change until then. */
const afterTheSetup = async (database: Executor): Promise<void> => {
  if ((await setupStatus(database)) === 'open') throw new ServerChangeRefused('setup-unfinished');
};

const audited =
  (
    { clock }: ServerAdminDependencies,
    admin: ServerAdminSession,
    action: ServerAuditAction,
  ): ((transaction: Transaction) => Promise<void>) =>
  async (transaction) => {
    await recordServerAudit(transaction, clock, { actorUserId: admin.userId, action });
  };

/** The administrator's own address and the language they read: where a test letter goes, and in what. */
const addressOf = async (
  executor: Executor,
  admin: ServerAdminSession,
): Promise<{ readonly email: string; readonly locale: SignInLocale }> => {
  const row = await executor
    .selectFrom('users')
    .select(['email', 'locale'])
    .where('id', '=', admin.userId)
    .where('deleted_at', 'is', null)
    .executeTakeFirstOrThrow();
  return { email: row.email, locale: row.locale === 'tr' ? 'tr' : 'en' };
};

/** `GET /api/server/settings`: what the page shows. Never a secret. */
export const serverSettingsOf = async (
  { database }: Pick<ServerAdminDependencies, 'database'>,
  admin: ServerAdminSession,
  current: RuntimeServices,
  appUrl: string,
): Promise<ServerSettingsAnswer> => {
  await afterTheSetup(database);
  return {
    settings: settingsView(current.settings),
    needsReentry: current.needsReentry,
    appUrl,
    githubCallbackUrl: `${appUrl}${SIGN_IN_CALLBACK}`,
    oidcCallbackUrl: `${appUrl}${OIDC_CALLBACK}`,
    channels: {
      github: current.auth.github,
      email: current.mail !== undefined,
      oidc: current.auth.oidc !== undefined,
    },
    adminEmail: (await addressOf(database, admin)).email,
  };
};

/** GitHub's app tried under the administrator's authority and, only if it worked, kept and served. */
export const connectGitHub = async (
  dependencies: ServerAdminDependencies & {
    readonly github: Omit<GitHubProbeDependencies, 'timeoutMs'>;
  },
  admin: ServerAdminSession,
  candidate: { readonly clientId: string; readonly clientSecret: string },
): Promise<ProbeResult> => {
  await afterTheSetup(dependencies.database);
  const result = await probeGitHub(admin, candidate, {
    ...dependencies.github,
    timeoutMs: GITHUB_PROBE_TIMEOUT_MS,
  });
  if (!result.ok) return result;
  await applySettings(
    dependencies.database,
    { github: candidate },
    dependencies.change,
    audited(dependencies, admin, 'server.github_connected'),
  );
  return result;
};

/**
 * The single sign-on provider tried under the administrator's authority — its discovery, its keys and the
 * client's credentials (`probeOidc`) — and, only if it all worked, kept and served (D-200 §2). The secret
 * is sealed in the settings and never answered; a try that failed saves nothing and says why.
 */
export const connectOidc = async (
  dependencies: ServerAdminDependencies & { readonly oidc: OidcProbeDependencies },
  admin: ServerAdminSession,
  candidate: {
    readonly issuer: string;
    readonly clientId: string;
    readonly clientSecret: string;
    readonly name: string | undefined;
  },
): Promise<ProbeResult> => {
  await afterTheSetup(dependencies.database);
  const result = await probeOidc(admin, candidate, dependencies.oidc);
  if (!result.ok) return result;
  await applySettings(
    dependencies.database,
    { oidc: candidate },
    dependencies.change,
    audited(dependencies, admin, 'server.oidc_connected'),
  );
  return result;
};

/** The relay tried with a plain test letter to the administrator and, only if it took it, kept and served. */
export const connectRelay = async (
  dependencies: ServerAdminDependencies & {
    readonly appUrl: string;
    readonly transportFactory?: SmtpTransportFactory;
  },
  admin: ServerAdminSession,
  candidate: SmtpSettings,
): Promise<ProbeResult> => {
  await afterTheSetup(dependencies.database);
  const refused = candidateRefusal(candidate);
  if (refused !== undefined) throw refused;
  const { email, locale } = await addressOf(dependencies.database, admin);
  const result = await probeSmtp(admin, candidate, testLetter(email, dependencies.appUrl, locale), {
    transportFactory: dependencies.transportFactory ?? smtpTransport,
    timeoutMs: SMTP_PROBE_TIMEOUT_MS,
  });
  if (!result.ok) return result;
  await applySettings(
    dependencies.database,
    { smtp: candidate },
    dependencies.change,
    audited(dependencies, admin, 'server.smtp_connected'),
  );
  return result;
};

const TEST_WORDS = {
  en: {
    subject: 'A test from your Purlay server',
    text: (server: string): string =>
      `This is a test from the Purlay server at ${server}, sent because an administrator tried a mail relay: its mail works. There is nothing to do.\n\n${server}`,
  },
  tr: {
    subject: 'Purlay sunucundan bir deneme',
    text: (server: string): string =>
      `Bu, ${server} adresindeki Purlay sunucusundan bir deneme: bir yönetici bir e-posta sunucusunu denedi, e-posta çalışıyor. Yapacak bir şey yok.\n\n${server}`,
  },
} as const;

const testLetter = (to: string, appUrl: string, locale: SignInLocale): MailMessage => {
  const server = new URL(appUrl).origin;
  return textLetter(to, TEST_WORDS[locale].subject, TEST_WORDS[locale].text(server), server);
};

/**
 * One of the three ways in disconnected. Refused when it is not connected, and — unless
 * `confirmLastChannel` — when it was the last way in for other people.
 */
export const disconnect = async (
  dependencies: ServerAdminDependencies,
  admin: ServerAdminSession,
  channel: 'github' | 'smtp' | 'oidc',
  current: RuntimeServices,
  confirmLastChannel: boolean,
): Promise<void> => {
  await afterTheSetup(dependencies.database);
  // A secret the key could not open is read as unset, but its ciphertext is there: disconnecting it
  // clears it, under the same last-way-in rule, so a card that says *enter it again* can also let it go.
  const connected =
    {
      github: current.settings.github !== undefined,
      smtp: current.settings.smtp !== undefined,
      oidc: current.settings.oidc !== undefined,
    }[channel] || current.needsReentry.includes(channel);
  if (!connected) throw new ServerChangeRefused('not-connected');
  const record = audited(dependencies, admin, DISCONNECTED[channel]);
  try {
    await applySettings(
      dependencies.database,
      { github: { github: null }, smtp: { smtp: null }, oidc: { oidc: null } }[channel],
      dependencies.change,
      async (transaction) => {
        // What this transaction saved, under the swap's lock: the other way is still there, or not.
        const { settings } = await readSettingsToBoot(transaction, dependencies.change.cipher);
        if (channel !== 'smtp' && !settings.passwordSignIn && !hasProvider(settings)) {
          throw new ServerChangeRefused('passwords-off');
        }
        if (
          !confirmLastChannel &&
          settings.github === undefined &&
          settings.smtp === undefined &&
          settings.oidc === undefined
        ) {
          throw new ServerChangeRefused('last-channel');
        }
        await record(transaction);
      },
    );
  } catch (error) {
    throw refusalOf(error);
  }
};

/** The swap wraps what its transaction threw; a refusal is the caller's, not a failed swap. */
const refusalOf = (error: unknown): unknown =>
  error instanceof SettingsChangeFailed && error.cause instanceof ServerChangeRefused
    ? error.cause
    : error;

/**
 * Whether a provider that is not the server's own signs people in: GitHub or single sign-on, read as the
 * swap reads them — a secret the key cannot open is no way in (D-179 §6). Mail is not one: a link is the
 * server's own relay, and the administrator's address may be one a link does not sign into (D-239).
 */
const hasProvider = (settings: ServerSettings): boolean =>
  settings.github !== undefined || settings.oidc !== undefined;

/** What a change of one rule of `POST /api/server/policy` is called on the trail. */
const policyChanged = (change: ServerPolicyRequest): ServerAuditAction => {
  if ('signUp' in change) return 'server.sign_up_changed';
  if ('requireTwoFactor' in change) return 'server.two_factor_requirement_changed';
  if ('passwordSignIn' in change) return 'server.password_sign_in_changed';
  if ('sessionIdleTimeoutHours' in change) return 'server.session_idle_timeout_changed';
  return 'server.session_max_age_changed';
};

/**
 * One rule of the sign-in policy, saved and served at once: who may make an account, whether a password
 * account must turn on two-step verification, whether a password signs in (D-239), how long a session may go
 * unused and live (D-244). Each on its own trail's action. Password sign-in is turned off only while GitHub or
 * single sign-on is connected, weighed in the swap's transaction from what it saved. A lifetime applies to the
 * sessions already open from their next request: nothing else is written.
 */
export const changePolicy = async (
  dependencies: ServerAdminDependencies,
  admin: ServerAdminSession,
  change: ServerPolicyRequest,
): Promise<void> => {
  await afterTheSetup(dependencies.database);
  const record = audited(dependencies, admin, policyChanged(change));
  try {
    await applySettings(dependencies.database, change, dependencies.change, async (transaction) => {
      if ('passwordSignIn' in change && !change.passwordSignIn) {
        const { settings } = await readSettingsToBoot(transaction, dependencies.change.cipher);
        if (!hasProvider(settings)) throw new ServerChangeRefused('no-provider');
      }
      await record(transaction);
    });
  } catch (error) {
    throw refusalOf(error);
  }
};

/** Who may make a workspace, saved at once; the creating routes read it on every request. */
export const changeCreators = async (
  dependencies: ServerAdminDependencies,
  admin: ServerAdminSession,
  creators: ServerCreatorsRequest['workspaceCreators'],
): Promise<void> => {
  await afterTheSetup(dependencies.database);
  await applySettings(
    dependencies.database,
    {
      workspaceCreators:
        creators.kind === 'listed'
          ? { kind: 'listed', logins: new Set(creators.logins) }
          : { kind: creators.kind },
    },
    dependencies.change,
    audited(dependencies, admin, 'server.workspace_creators_changed'),
  );
};
