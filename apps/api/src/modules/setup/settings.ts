/**
 * The server's own settings, kept in the database (D-179 §6): who may sign up, GitHub's OAuth app, the
 * mail relay, and who may make a workspace. One row, `server_settings` (migration 0049), read whole and
 * written by patch.
 *
 * - **The secrets are sealed** by the one credential cipher (`platform/crypto.ts`, D-39 §6) — the GitHub
 *   client secret, and the relay's address, which carries its password — each with its column's name
 *   bound in, so a sealed value copied into the other column does not open there. A secret that does not
 *   open is `SealBroken`, said by the read, never a setting quietly treated as missing.
 * - **What may reach a response is the view** (`settingsView`): a secret is `{ set }`, the relay's
 *   address is shown as its host alone, and the type has no field a secret could be put in. Nothing
 *   here logs a value.
 * - **The environment is the seed of the first start, once** (`importFromEnvOnce`). Afterwards the row
 *   is the only home, and a variable still set does nothing but be named at start (`ignoredEnvironment`).
 *
 * What the row cannot hold is the server's address — `APP_URL` stays in the environment, since the
 * cookies, the origin checks and the sign-in library are fixed by it when they are built (Ruling R35) —
 * and the secret sessions are signed with, which is derived from `ENCRYPTION_KEY` and never a setting.
 */
import type { Executor } from '@purlay/db';
import type { ServerSettingsView } from '@purlay/types';
import type { AuthSettings } from '../auth/better-auth';
import { workspaceCreatorsOf, type WorkspaceCreators } from '../workspaces/creators';
import type { Clock } from '../../platform/clock';
import type { Config } from '../../platform/config';
import { SealBroken, type CredentialCipher } from '../../platform/crypto';
import { smtpUrlProblem } from '../../platform/smtp-address';
import { atomicallyOn } from '../../platform/transactions';

/** The relay mail is sent through (D-138 §6). */
export interface SmtpSettings {
  /**
   * `smtp://` or `smtps://`, its credentials in it: a secret, whole. Named so the logger's list finds it
   * at any depth (`NEVER_LOGGED`), which a field called `url` could not be.
   */
  readonly smtpUrl: string;
  /** The address letters come from. */
  readonly from: string;
  /** A relay past this machine may be spoken to without TLS: the operator says the link is private. */
  readonly allowPlaintext: boolean;
}

/** Everything the server reads from its settings: what the sign-in library takes, and the rest. */
export interface ServerSettings extends AuthSettings {
  readonly smtp: SmtpSettings | undefined;
  /** Who may make a workspace (D-155, D-169). */
  readonly workspaceCreators: WorkspaceCreators;
  /** When the setup in the browser was finished; unset until it is. */
  readonly setupCompletedAt: Date | undefined;
}

/**
 * A change to the settings. A field left out, or `undefined`, is left as it is; `null` clears it. A pair
 * — the GitHub app, the relay — is written whole or cleared whole.
 */
export interface SettingsPatch {
  readonly signUp?: AuthSettings['signUp'] | undefined;
  readonly github?: NonNullable<AuthSettings['github']> | null | undefined;
  readonly smtp?: SmtpSettings | null | undefined;
  readonly workspaceCreators?: WorkspaceCreators | undefined;
  /**
   * When the setup was finished — set once, by the finish rule, and never cleared: a setup unfinished
   * again would open `/setup` on a server in use (D-179 §4.8).
   */
  readonly setupCompletedAt?: Date | undefined;
}

/** What the environment says of the settings, already checked by the configuration (`envSeedOf`). */
export interface SettingsSeed {
  readonly github?: NonNullable<AuthSettings['github']>;
  readonly smtp?: SmtpSettings;
  readonly workspaceCreators: WorkspaceCreators;
}

/**
 * What each sealed value is bound to: its column. A ciphertext moved to the other column, by a hand or
 * a bug, does not open there (`CredentialCipher`'s additional data).
 */
const SEALED_IN = {
  githubClientSecret: 'server_settings.github_client_secret_encrypted',
  smtpUrl: 'server_settings.smtp_url_encrypted',
} as const;

/** A server that has never written its settings reads these: closed, nothing connected. */
const DEFAULTS: ServerSettings = {
  signUp: 'invite-only',
  github: undefined,
  smtp: undefined,
  workspaceCreators: { kind: 'first' },
  setupCompletedAt: undefined,
};

/** A GitHub login, as the configuration's `WORKSPACE_CREATORS` pattern takes one (D-155). */
const LOGIN = /^[a-z0-9][a-z0-9-]{0,38}$/;
/** Whether `login` is a GitHub login as the creators setting takes one (lower case, as it is kept). */
export const isGitHubLogin = (login: string): boolean => LOGIN.test(login);

/** An address, roughly: the relay is the judge of the rest. */
const ADDRESS = /^[^\s@<>]+@[^\s@<>]+$/;

const sealed = async (
  cipher: CredentialCipher,
  secret: string,
  column: (typeof SEALED_IN)[keyof typeof SEALED_IN],
): Promise<string> => Buffer.from(await cipher.seal(secret, column)).toString('base64');

const opened = async (
  cipher: CredentialCipher,
  value: string,
  column: (typeof SEALED_IN)[keyof typeof SEALED_IN],
): Promise<string> => await cipher.open(Buffer.from(value, 'base64'), column);

const signUpOf = (stored: string): AuthSettings['signUp'] => {
  if (stored === 'invite-only' || stored === 'open') return stored;
  // The column's check refuses anything else; a row past it is a defect, said loudly.
  throw new Error(`server_settings.sign_up holds an unknown value`);
};

const creatorsOf = (kind: string, logins: readonly string[]): WorkspaceCreators => {
  if (kind === 'first' || kind === 'anyone') return { kind };
  if (kind === 'listed') return { kind, logins: new Set(logins) };
  throw new Error(`server_settings.workspace_creators holds an unknown value`);
};

/** A setting that holds a sealed secret: what a rotated `ENCRYPTION_KEY` leaves unreadable. */
export type SealedSetting = 'github' | 'smtp';

/** The settings as a start reads them, and which sealed secrets it could not open. */
export interface BootSettings {
  readonly settings: ServerSettings;
  /**
   * The settings whose secret did not open, each read as unset (`readSettingsToBoot`): the wizard and the
   * Administration page say *this secret needs to be entered again*. The ciphertext is still in the row.
   */
  readonly needsReentry: readonly SealedSetting[];
}

/**
 * The settings, the secrets opened — and, with `broken`, the way a secret that does not open is told
 * rather than thrown. Without it, `SealBroken` is the read's answer.
 */
const readWith = async (
  executor: Executor,
  cipher: CredentialCipher,
  broken: ((setting: SealedSetting) => void) | undefined,
): Promise<ServerSettings> => {
  const row = await executor.selectFrom('server_settings').selectAll().executeTakeFirst();
  if (row === undefined) return DEFAULTS;
  /** A sealed value, opened; or, where `broken` is given, that it would not open — and nothing. */
  const open = async (
    setting: SealedSetting,
    value: string,
    column: (typeof SEALED_IN)[keyof typeof SEALED_IN],
  ): Promise<string | undefined> => {
    try {
      return await opened(cipher, value, column);
    } catch (error) {
      if (error instanceof SealBroken && broken !== undefined) {
        broken(setting);
        return undefined;
      }
      throw error;
    }
  };
  const githubSecret =
    row.github_client_id === null || row.github_client_secret_encrypted === null
      ? undefined
      : await open('github', row.github_client_secret_encrypted, SEALED_IN.githubClientSecret);
  const github =
    row.github_client_id === null || githubSecret === undefined
      ? undefined
      : { clientId: row.github_client_id, clientSecret: githubSecret };
  const smtpUrl =
    row.smtp_url_encrypted === null || row.mail_from === null
      ? undefined
      : await open('smtp', row.smtp_url_encrypted, SEALED_IN.smtpUrl);
  const smtp =
    smtpUrl === undefined || row.mail_from === null
      ? undefined
      : { smtpUrl, from: row.mail_from, allowPlaintext: row.smtp_allow_plaintext };
  return {
    signUp: signUpOf(row.sign_up),
    github,
    smtp,
    workspaceCreators: creatorsOf(row.workspace_creators, row.workspace_creator_logins),
    setupCompletedAt: row.setup_completed_at ?? undefined,
  };
};

/** The settings, the secrets opened. Never logged by this or by anything it calls. */
export const readSettings = async (
  executor: Executor,
  cipher: CredentialCipher,
): Promise<ServerSettings> => await readWith(executor, cipher, undefined);

/**
 * The settings as a start reads them (D-179 §6, R38): a secret that does not open — an
 * `ENCRYPTION_KEY` that was rotated — is read as unset and named in `needsReentry`, so the server
 * starts and waits in setup mode for the secret to be entered again, instead of refusing to start.
 * **Nothing is deleted or rewritten**: the ciphertext stays until a new value is saved over it. Any
 * other failure — a row that does not decode, a database that fails — is thrown, as it always was.
 */
export const readSettingsToBoot = async (
  executor: Executor,
  cipher: CredentialCipher,
): Promise<BootSettings> => {
  const needsReentry = new Set<SealedSetting>();
  const settings = await readWith(executor, cipher, (setting) => needsReentry.add(setting));
  return { settings, needsReentry: [...needsReentry] };
};

/** Who may make a workspace, alone: what `GET /api/me` and a create ask, with no secret opened. */
export const readWorkspaceCreators = async (executor: Executor): Promise<WorkspaceCreators> => {
  const row = await executor
    .selectFrom('server_settings')
    .select(['workspace_creators', 'workspace_creator_logins'])
    .executeTakeFirst();
  return row === undefined
    ? DEFAULTS.workspaceCreators
    : creatorsOf(row.workspace_creators, row.workspace_creator_logins);
};

/** The columns a patch writes, the secrets sealed; refuses a value the settings could not hold. */
interface Written {
  sign_up?: string;
  github_client_id?: string | null;
  github_client_secret_encrypted?: string | null;
  smtp_url_encrypted?: string | null;
  mail_from?: string | null;
  smtp_allow_plaintext?: boolean;
  workspace_creators?: string;
  workspace_creator_logins?: string[];
  setup_completed_at?: Date | null;
}

const columnsOf = async (cipher: CredentialCipher, patch: SettingsPatch): Promise<Written> => {
  const written: Written = {};
  if (patch.signUp !== undefined) written.sign_up = patch.signUp;
  if (patch.github === null) {
    written.github_client_id = null;
    written.github_client_secret_encrypted = null;
  } else if (patch.github !== undefined) {
    if (patch.github.clientId === '' || patch.github.clientSecret === '') {
      throw new Error('a GitHub app is its client id and its client secret, both');
    }
    written.github_client_id = patch.github.clientId;
    written.github_client_secret_encrypted = await sealed(
      cipher,
      patch.github.clientSecret,
      SEALED_IN.githubClientSecret,
    );
  }
  if (patch.smtp === null) {
    written.smtp_url_encrypted = null;
    written.mail_from = null;
    written.smtp_allow_plaintext = false;
  } else if (patch.smtp !== undefined) {
    // Parsed as the transport will parse it: a value it could not be built from would otherwise be
    // kept, and stop every start after (D-179 §6). The reason says the rule, never the value.
    const problem = smtpUrlProblem(patch.smtp.smtpUrl);
    if (problem !== undefined) throw new Error(`the relay's address: ${problem}`);
    if (!ADDRESS.test(patch.smtp.from)) throw new Error('letters come from an address');
    written.smtp_url_encrypted = await sealed(cipher, patch.smtp.smtpUrl, SEALED_IN.smtpUrl);
    written.mail_from = patch.smtp.from;
    written.smtp_allow_plaintext = patch.smtp.allowPlaintext;
  }
  if (patch.workspaceCreators !== undefined) {
    const creators = patch.workspaceCreators;
    written.workspace_creators = creators.kind;
    if (creators.kind === 'listed') {
      const logins = [...creators.logins].map((login) => login.toLowerCase());
      if (logins.length === 0 || !logins.every((login) => LOGIN.test(login))) {
        throw new Error('a list of creators is one or more GitHub logins');
      }
      written.workspace_creator_logins = [...new Set(logins)].sort();
    } else {
      written.workspace_creator_logins = [];
    }
  }
  // The type says so already; a value that reached here round it (a parsed body, a cast) is refused too.
  if ((patch.setupCompletedAt as unknown) === null)
    throw new Error('a finished setup stays finished');
  if (patch.setupCompletedAt !== undefined) written.setup_completed_at = patch.setupCompletedAt;
  return written;
};

/**
 * Writes what the patch names, in one statement: the row is made if there is none, and either every
 * field of the patch is written or none is. Sealing happens before, so the statement holds no lock while
 * a key is derived.
 */
export const saveSettings = async (
  executor: Executor,
  cipher: CredentialCipher,
  clock: Clock,
  patch: SettingsPatch,
): Promise<void> => {
  const written = { ...(await columnsOf(cipher, patch)), updated_at: clock.now() };
  await executor
    .insertInto('server_settings')
    .values({ id: true, ...written })
    .onConflict((conflict) => conflict.column('id').doUpdateSet(written))
    .execute();
};

/** Where the relay is — scheme, host and port — and nothing of who signs in to it. */
export const relayHost = (smtpUrl: string): string => {
  const parsed = new URL(smtpUrl);
  return `${parsed.protocol}//${parsed.host}`;
};

/** The settings as a response may carry them (`ServerSettingsView`, `@purlay/types`). */
export const settingsView = (settings: ServerSettings): ServerSettingsView => ({
  signUp: settings.signUp,
  github:
    settings.github === undefined
      ? null
      : { clientId: settings.github.clientId, clientSecret: { set: true } },
  smtp:
    settings.smtp === undefined
      ? null
      : {
          address: { set: true, host: relayHost(settings.smtp.smtpUrl) },
          from: settings.smtp.from,
          allowPlaintext: settings.smtp.allowPlaintext,
        },
  workspaceCreators:
    settings.workspaceCreators.kind === 'listed'
      ? { kind: 'listed', logins: [...settings.workspaceCreators.logins].sort() }
      : { kind: settings.workspaceCreators.kind },
  setupCompletedAt: settings.setupCompletedAt?.toISOString() ?? null,
});

type Seeding = Pick<
  Config,
  | 'GITHUB_CLIENT_ID'
  | 'GITHUB_CLIENT_SECRET'
  | 'SMTP_URL'
  | 'MAIL_FROM'
  | 'SMTP_ALLOW_PLAINTEXT'
  | 'WORKSPACE_CREATORS'
>;

/** What the environment says of the settings: the seed of a first start. */
export const envSeedOf = (config: Seeding): SettingsSeed => ({
  // Both or neither (the configuration checks it): a server started with no GitHub variable imports
  // a row without a GitHub app, and the wizard fills it in later (D-179 §4).
  ...(config.GITHUB_CLIENT_ID === undefined || config.GITHUB_CLIENT_SECRET === undefined
    ? {}
    : {
        github: { clientId: config.GITHUB_CLIENT_ID, clientSecret: config.GITHUB_CLIENT_SECRET },
      }),
  ...(config.SMTP_URL === undefined || config.MAIL_FROM === undefined
    ? {}
    : {
        smtp: {
          smtpUrl: config.SMTP_URL,
          from: config.MAIL_FROM,
          allowPlaintext: config.SMTP_ALLOW_PLAINTEXT,
        },
      }),
  workspaceCreators: workspaceCreatorsOf(config.WORKSPACE_CREATORS),
});

/**
 * The variables this environment sets that only a first start reads: named at every start once the
 * settings are the database's, so an operator who edits one is told it does nothing. Names only.
 */
export const ignoredEnvironment = (config: Seeding): string[] =>
  (
    [
      ['GITHUB_CLIENT_ID', config.GITHUB_CLIENT_ID !== undefined],
      ['GITHUB_CLIENT_SECRET', config.GITHUB_CLIENT_SECRET !== undefined],
      ['SMTP_URL', config.SMTP_URL !== undefined],
      ['MAIL_FROM', config.MAIL_FROM !== undefined],
      // A boolean with a default: only `true` is something the operator wrote.
      ['SMTP_ALLOW_PLAINTEXT', config.SMTP_ALLOW_PLAINTEXT],
      ['WORKSPACE_CREATORS', config.WORKSPACE_CREATORS !== undefined],
    ] as const
  )
    .filter(([, set]) => set)
    .map(([name]) => name);

/**
 * Copies the environment into the settings, once in the life of the database (D-179 §6). The first
 * start finds no row, or one never imported, and writes the seed with `imported_from_env_at`; every later
 * start finds that set and leaves the row alone — whatever the environment says now, and whatever was
 * changed in the browser since.
 *
 * Two processes starting at once: each inserts the row or finds it — the second's insert waits on the
 * first's uncommitted one and then does nothing — and reads it locked, so the second sees the first's
 * commit and says `already`. One row, one lock, taken in one order: no deadlock to be had.
 */
export const importFromEnvOnce = async (
  executor: Executor,
  cipher: CredentialCipher,
  clock: Clock,
  seed: SettingsSeed,
): Promise<'imported' | 'already'> => {
  // Sealed before the transaction: nothing waits on a lock while a key is derived.
  const columns = await columnsOf(cipher, {
    github: seed.github ?? null,
    smtp: seed.smtp ?? null,
    workspaceCreators: seed.workspaceCreators,
  });
  return await atomicallyOn(executor)(async (transaction) => {
    await transaction
      .insertInto('server_settings')
      .values({ id: true })
      .onConflict((conflict) => conflict.column('id').doNothing())
      .execute();
    const row = await transaction
      .selectFrom('server_settings')
      .select('imported_from_env_at')
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (row.imported_from_env_at !== null) return 'already';
    const now = clock.now();
    await transaction
      .updateTable('server_settings')
      .set({ ...columns, imported_from_env_at: now, updated_at: now })
      .execute();
    return 'imported';
  });
};
