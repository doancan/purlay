/**
 * What the server serves with, built from its settings (D-179 §6): the sign-in library's instance and
 * the mail relay it posts through. One function builds both from one reading of the settings, so the
 * relay the library mails sign-in links through and the one invitations go by are always the same, and
 * the place a change of settings rebuilds them is this one (`runtimeServicesFrom`).
 *
 * **One holder, filled once and swapped after** (`runtimeServicesHolder`, D-179 §4 "A changed setting
 * takes effect without a restart"):
 *
 * - The settings are in the database, and can be read only once its migrations are in — after the
 *   process already listens, so liveness answers through a long migration (D-93). Until they are read,
 *   the application holds the holder's stand-in: every use of the instance is refused as the server
 *   being busy (`503 DATABASE_UNAVAILABLE`, which a client retries), readiness says why, and nothing is
 *   served by a library built from settings nobody read (`settle`, once).
 * - **A change of settings builds a new pair and swaps it in** (`applySettings`): the library fixes its
 *   providers and plugins when an instance is built, and has no way to change them on a running one
 *   (measured, Q5), so the instance is replaced, never edited. Saved, read back, built and checked in
 *   one transaction; swapped only once that has committed; on any failure before the commit nothing is
 *   saved and the old pair serves on.
 * - **A request is served by the pair it started on.** The application holds `auth`, a stand-in that
 *   reads, on every use, the pair *this request* pinned when it arrived (`pin`, from the first hook), so a
 *   swap while a request is in flight lets it finish on the old instance and the next one starts on the
 *   new. Work it left for after its answer is the same flow, and uses the same pair.
 * - **The replaced relay is let go cleanly**: what it was sending is waited for, then its transport is
 *   closed; every send of every relay this process ever built is in one ledger (`mailInFlight`), which
 *   is what a shutdown waits for.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { isTransaction, type Executor, type Transaction } from '@purlay/db';
import { AUTH_BASE_PATH } from '@purlay/types';
import type { Auth, AuthDependencies } from '../auth/better-auth';
import { createAuth } from '../auth/better-auth';
import type { Clock } from '../../platform/clock';
import type { CredentialCipher } from '../../platform/crypto';
import { AppError } from '../../platform/errors';
import type { Logger } from '../../platform/logging';
import {
  mailInFlight,
  outbox,
  smtpMailer,
  type MailInFlight,
  type Mailer,
  type Outbox,
} from '../../platform/mail';
import {
  readSettingsToBoot,
  saveSettings,
  type SealedSetting,
  type ServerSettings,
  type SettingsPatch,
} from './settings';

/** What the server serves with, as its settings say. */
export interface RuntimeServices {
  readonly auth: Auth;
  /** The relay, to ask at start whether it answers; absent where no mail is configured. */
  readonly mailer: Mailer | undefined;
  /** What letters are posted to, after the answer; absent where no mail is configured (D-138 §6). */
  readonly mail: Outbox | undefined;
  /**
   * The settings whose sealed secret did not open at this start — an `ENCRYPTION_KEY` that was rotated —
   * and which are therefore served as unset until the wizard or the Administration page takes a new value
   * (R38, D-179 §6). The ciphertext is still in the database.
   */
  readonly needsReentry: readonly SealedSetting[];
  /**
   * The settings these were built from, secrets and all: what the process serves by, never logged and
   * never answered (a response carries `settingsView`).
   */
  readonly settings: ServerSettings;
}

/** Everything the instance needs that is not a setting: the process's own, from the environment. */
export type RuntimeBase = Omit<AuthDependencies, 'settings' | 'mailer'>;

/**
 * The library's instance and the relay, from one reading of the settings. Builds; connects to nothing
 * (the relay is asked nothing until a letter is posted or `checkRelay` asks it). `sends` is the ledger
 * the relay's letters are counted in, so a shutdown waits for them after the relay has been replaced.
 */
export const runtimeServicesFrom = (
  settings: ServerSettings,
  base: RuntimeBase,
  needsReentry: readonly SealedSetting[] = [],
  sends?: MailInFlight,
): RuntimeServices => {
  const mailer =
    settings.smtp === undefined
      ? undefined
      : smtpMailer({
          SMTP_URL: settings.smtp.smtpUrl,
          MAIL_FROM: settings.smtp.from,
          SMTP_ALLOW_PLAINTEXT: settings.smtp.allowPlaintext,
        });
  const mail = mailer === undefined ? undefined : outbox(mailer.send, base.log, sends);
  const auth = createAuth({
    ...base,
    settings: { github: settings.github, signUp: settings.signUp },
    mailer: mail,
  });
  return { auth, mailer, mail, needsReentry, settings };
};

/** What a request that needs the library is answered while the settings are not read yet. */
const starting = (): AppError =>
  new AppError({
    code: 'DATABASE_UNAVAILABLE',
    message: 'The server is starting. Try again shortly.',
  });

/** Readiness's reason, while it waits. */
export const SETTINGS_NOT_READ = 'the server has not read its settings yet';

/** How long a replaced relay's letters are waited for before its transport is let go. */
const RETIRE_BOUND_MS = 2_000;
/** What a replaced relay's flush says of the letters it is still sending past that bound. */
const RETIRE_LEFT = 'mail still being sent by the relay the settings replaced';

/**
 * What the application takes of the holder: pinning the pair a request is served by. Absent where a
 * test hands the application an instance of its own, which nothing swaps.
 */
export interface ServicesPin {
  /** The rest of this flow — a request, from its first hook — is served by the pair current now. */
  readonly pin: () => void;
  /** `body`, and everything it starts, served by the pair current now: a socket's open, its admission. */
  readonly within: <T>(body: () => T) => T;
}

/** The application's services before the settings are read, after, and across a change of them. */
export interface RuntimeHolder extends ServicesPin {
  /**
   * The instance the application is built with: refused until `settle`; after, on every use, the
   * instance of the pair the flow pinned — or, outside any pinned flow, the current one.
   */
  readonly auth: Auth;
  /** Hands over what the settings built. Once: a second call is a defect, and throws. */
  readonly settle: (services: RuntimeServices) => void;
  /** What serves now, or nothing yet. */
  readonly current: () => RuntimeServices | undefined;
  /**
   * Puts `next` in place at once — the next request is served by it — then lets the replaced pair go:
   * waits for what its relay is sending and closes its transport. Resolves when it has. Only after
   * `settle`: there is nothing to replace before.
   */
  readonly replace: (next: RuntimeServices) => Promise<void>;
  /** Runs `body` after every change before it has finished, and holds the next until it has. */
  readonly exclusively: <T>(body: () => Promise<T>) => Promise<T>;
  /** The ledger every relay this holder serves with counts its sends in. */
  readonly sends: MailInFlight;
  /** From now on, every change of the settings is refused: the process is shutting down. */
  readonly refuseChanges: () => void;
  /** Whether `refuseChanges` was called. */
  readonly changesRefused: () => boolean;
}

/** The pair a flow was pinned to; a box, so a flow pinned before the settle reads the settled one. */
interface Pinned {
  readonly services: RuntimeServices | undefined;
}

export const runtimeServicesHolder = (log: Logger): RuntimeHolder => {
  let settled: RuntimeServices | undefined;
  const pinned = new AsyncLocalStorage<Pinned>();
  const serving = (): RuntimeServices | undefined => pinned.getStore()?.services ?? settled;
  let queue: Promise<unknown> = Promise.resolve();
  let refused = false;
  const sends = mailInFlight(log);

  const auth = new Proxy({} as Auth, {
    get: (_target, property): unknown => {
      const services = serving();
      if (services !== undefined) return Reflect.get(services.auth, property);
      // Readiness asks this one, and is told why it must wait instead of being refused.
      if (property === 'schemaProblem') {
        return async (): Promise<string> => await Promise.resolve(SETTINGS_NOT_READ);
      }
      // The log line of the refusal itself names a path under the library's base by its route: with no
      // table to read yet, every such path is the placeholder (D-179 §3), never what the caller sent.
      if (property === 'routeOf') return (): string => `${AUTH_BASE_PATH}/*`;
      // Not a promise: a caller that awaits the instance itself is handed it, not refused.
      if (property === 'then' || typeof property === 'symbol') return undefined;
      throw starting();
    },
  });

  /** The replaced pair let go: its letters waited for, within a bound, then its transport closed. */
  const retire = async (old: RuntimeServices, next: RuntimeServices): Promise<void> => {
    if (old.mail !== undefined && old.mail !== next.mail) {
      // A send past the bound goes on, and so does one that work pinned to the old pair posts later
      // (after its answer): the transport is unpooled — a connection per letter, `close` closes nothing
      // (`mail.test.ts` pins it) — and the ledger keeps each for the shutdown to wait for.
      await old.mail.flush(RETIRE_BOUND_MS, RETIRE_LEFT);
    }
    if (old.mailer !== undefined && old.mailer !== next.mailer) old.mailer.close();
  };

  return {
    auth,
    settle: (services): void => {
      if (settled !== undefined) throw new Error('the server’s services are settled once');
      settled = services;
    },
    current: () => settled,
    replace: async (next): Promise<void> => {
      const old = settled;
      if (old === undefined) throw new Error('nothing is served yet to replace: settle first');
      settled = next;
      await retire(old, next);
    },
    pin: (): void => {
      pinned.enterWith({ services: settled });
    },
    within: (body) => pinned.run({ services: settled }, body),
    exclusively: async <T>(body: () => Promise<T>): Promise<T> => {
      const turn = queue.then(body, body);
      // The next waits for this one however it ended; its failure is this caller's to hear, not the next's.
      queue = turn.catch(() => undefined);
      return await turn;
    },
    sends,
    refuseChanges: (): void => {
      refused = true;
    },
    changesRefused: () => refused,
  };
};

/**
 * Where a change of the settings stopped, and what serves now:
 *
 * - `starting` — the server has not read its settings yet; nothing was saved.
 * - `shutting-down` — the process is draining; nothing was saved, and the next start serves as before.
 * - `save`, `build`, `verify` — the patch was refused, the new pair could not be built from it, or the
 *   library's check of the database failed on it: **nothing was saved, and the old pair serves on**.
 * - `commit` — the database did not confirm the save: it may or may not hold the patch, and the old pair
 *   serves. **Restart the server**: a start serves what the database holds.
 * - `retire` — the new settings are saved and serve; the replaced relay could not be let go. Restart the
 *   server to release it.
 */
export type SettingsChangeStage =
  'starting' | 'shutting-down' | 'save' | 'build' | 'verify' | 'commit' | 'retire';

/** What each stage leaves serving. */
const IN_EFFECT: Record<SettingsChangeStage, 'old' | 'new' | 'unknown'> = {
  starting: 'old',
  'shutting-down': 'old',
  save: 'old',
  build: 'old',
  verify: 'old',
  commit: 'unknown',
  retire: 'new',
};

const SENTENCES: Record<SettingsChangeStage, string> = {
  starting: 'The server is still starting; nothing was changed. Try again shortly.',
  'shutting-down':
    'The server is shutting down; nothing was changed. Try again once it has started again.',
  save: 'The settings were not saved; the server serves as it did.',
  build: 'The settings could not be put to use; nothing was saved and the server serves as it did.',
  verify:
    'The sign-in library cannot work with these settings on this database; nothing was saved and the server serves as it did.',
  commit:
    'The database did not confirm the change, so it may or may not be saved. Restart the server: it serves what the database holds.',
  retire:
    'The new settings are saved and in use, but the mail relay they replaced could not be let go. Restart the server to release it.',
};

/** A change of the settings that did not complete; see `SettingsChangeStage`. Never carries a value. */
export class SettingsChangeFailed extends Error {
  readonly stage: SettingsChangeStage;
  /** Which settings serve now: the ones before the change, the changed ones, or — `commit` — unknown. */
  readonly inEffect: 'old' | 'new' | 'unknown';
  /** Whether only a restart puts the process and the database back in step. */
  readonly restartNeeded: boolean;

  constructor(stage: SettingsChangeStage, cause?: unknown) {
    super(SENTENCES[stage], cause === undefined ? undefined : { cause });
    this.name = 'SettingsChangeFailed';
    this.stage = stage;
    this.inEffect = IN_EFFECT[stage];
    this.restartNeeded = stage === 'commit' || stage === 'retire';
  }
}

/** What a change of the settings needs besides the holder. */
export interface SettingsChange {
  readonly holder: RuntimeHolder;
  readonly cipher: CredentialCipher;
  readonly clock: Clock;
  readonly log: Logger;
  /** The pair from settings: the composition root's, the same one the start built with. */
  readonly build: (
    settings: ServerSettings,
    needsReentry: readonly SealedSetting[],
  ) => RuntimeServices;
}

/** A stage's work, any failure of it this stage's. */
const at = async <T>(stage: SettingsChangeStage, work: () => Promise<T> | T): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    if (error instanceof SettingsChangeFailed) throw error;
    throw new SettingsChangeFailed(stage, error);
  }
};

/** A pair built for a change that did not happen: its relay let go, nothing of it served. */
const discard = (candidate: RuntimeServices | undefined, holder: RuntimeHolder): void => {
  const served = holder.current();
  if (candidate?.mailer !== undefined && candidate.mailer !== served?.mailer) {
    candidate.mailer.close();
  }
};

/**
 * Saves `patch` and serves by it from the next request, without a restart (D-179 §4).
 *
 * In one transaction of its own — `executor` is the pool, never a caller's transaction, whose commit
 * would not be this function's to wait for: the patch saved, the whole row read back as the next start
 * would read it, the pair built from that, and the library's check of the database asked of the new
 * instance. Any failure there rolls the save back and the old pair serves on. Only once the commit is
 * confirmed is the new pair swapped in — a synchronous step that cannot fail — so the database and the
 * process disagree for no longer than that step, and a process that dies at any point leaves the
 * database as the next start should read it. Then the replaced relay is let go.
 *
 * Two changes at once run one after the other, the second reading what the first saved.
 */
export const applySettings = async (
  executor: Executor,
  patch: SettingsPatch,
  change: SettingsChange,
  /**
   * Written in the same transaction, after the save and before the commit: the change's audit row
   * (D-26), which then exists exactly when the change does. A failure of it is a failure to save.
   */
  alongside?: (transaction: Transaction) => Promise<void>,
): Promise<RuntimeServices> => {
  const { holder, cipher, clock, build, log } = change;
  if (isTransaction(executor)) {
    throw new Error(
      'a change of the settings commits on its own: pass the pool, not a transaction',
    );
  }
  return await holder.exclusively(async () => {
    // Also a change that waited its turn while the drain began.
    if (holder.changesRefused()) throw new SettingsChangeFailed('shutting-down');
    if (holder.current() === undefined) throw new SettingsChangeFailed('starting');
    let candidate: RuntimeServices | undefined;
    // Whether the body finished: what is thrown after it is the commit's. An object, as the body sets it.
    const reached = { commit: false };
    try {
      candidate = await executor.transaction().execute(async (transaction) => {
        await at('save', async () => {
          await saveSettings(transaction, cipher, clock, patch);
          await alongside?.(transaction);
        });
        // What this transaction wrote, as the next start would read it — never the patch laid over a copy.
        const { settings, needsReentry } = await at(
          'save',
          async () => await readSettingsToBoot(transaction, cipher),
        );
        const built = await at('build', () => build(settings, needsReentry));
        candidate = built;
        const problem = await at('verify', async () => await built.auth.schemaProblem());
        if (problem !== undefined) throw new SettingsChangeFailed('verify', new Error(problem));
        reached.commit = true;
        return built;
      });
    } catch (error) {
      discard(candidate, holder);
      if (error instanceof SettingsChangeFailed) throw error;
      // Thrown past the body, which had finished: the commit itself.
      throw new SettingsChangeFailed(reached.commit ? 'commit' : 'save', error);
    }
    try {
      await holder.replace(candidate);
    } catch (error) {
      throw new SettingsChangeFailed('retire', error);
    }
    // Which ways in changed, never a value.
    log.info('the server settings changed and serve from now on', {
      github: candidate.auth.github,
      email: candidate.mail !== undefined,
      signUp: candidate.settings.signUp,
    });
    return candidate;
  });
};
