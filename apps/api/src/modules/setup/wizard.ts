/**
 * The setup's steps as the wizard takes them (D-179 §4): what each step does beyond recording itself,
 * under the claim the browser holds — each one weighed again here, under the setup row's lock, however
 * the caller came by the session.
 *
 * - **A step in its turn.** A step is taken only once every step before it is passed (`reachable`):
 *   checked before anything is tried, so a try out of turn neither calls GitHub or a relay nor saves.
 * - **Tried, then kept** (§4.4, Ruling R37). GitHub's app and the relay are tried with the candidate
 *   values; only a try that worked, and only when the caller says to keep it, is saved — by
 *   `applySettings`, which swaps what serves without a restart — and its step recorded with the try
 *   remembered (`recordChannelTried`). A try that failed, or one not to be kept, saves nothing and
 *   passes no step.
 * - **The relay is tried with the administrator's own letter** (§4.3, Ruling R47): the link that
 *   verifies their address. An address verified already gets a plain test letter instead, since there
 *   is no link left to send and a try still needs a letter.
 * - **The first workspace** is the administrator's, made through the workspaces module as any is, with
 *   `#general`. Who may make a workspace (`WORKSPACE_CREATORS`, D-155) is not asked: the claim is the
 *   authority here, and the rule exists to keep strangers out of a running server — the setup's
 *   administrator is the person it would let in first. Made once: asked again, the one made is the
 *   answer.
 * - **The finish rule** (§4.5): every step before it passed, the first workspace there, and at least
 *   one way for other people to sign in connected after a try that worked **and serving now** — a
 *   GitHub app the probe accepted, or a relay that took the letter. A GitHub app or relay that is only
 *   in the settings — seeded from the environment, never tried — does not count. Then `completeSetup`,
 *   in the same transaction.
 */
import type { Executor, Transaction } from '@purlay/db';
import type { FinishProblem, ProbeResult, SetupStep, Workspace } from '@purlay/types';
import type { Clock } from '../../platform/clock';
import { smtpTransport, type MailMessage, type SmtpTransportFactory } from '../../platform/mail';
import { atomicallyOn } from '../../platform/transactions';
import type { SignInLocale } from '../auth/sign-in-letters';
import { createWorkspace } from '../workspaces/workspaces';
import {
  candidateRefusal,
  GITHUB_PROBE_TIMEOUT_MS,
  probeGitHub,
  probeSmtp,
  SMTP_PROBE_TIMEOUT_MS,
  type GitHubProbeDependencies,
} from './probes';
import { applySettings, type SettingsChange } from './runtime';
import type { SmtpSettings } from './settings';
import {
  completeSetup,
  heldBy,
  reachable,
  recordChannelTried,
  recordStep,
  SetupRefused,
  stepsOf,
  type SetupSession,
} from './setup';
import {
  adminVerificationLetter,
  issueAdminVerification,
  relayTestLetter,
  VerificationRefused,
} from './verification';

/** The setup's finish refused, with every reason that holds (`FinishProblem`). */
export class FinishRefused extends Error {
  readonly problems: readonly FinishProblem[];

  constructor(problems: readonly FinishProblem[]) {
    super('Setup cannot be finished yet.');
    this.name = 'FinishRefused';
    this.problems = problems;
  }
}

/** Which ways in the serving instance has now: GitHub's provider, and a relay to mail through. */
export interface Serving {
  readonly github: boolean;
  readonly email: boolean;
}

/** What a step that changes the settings needs: the pool — a change commits on its own — and the swap. */
export interface WizardDependencies {
  readonly database: Executor;
  readonly clock: Clock;
  readonly change: SettingsChange;
}

/** The setup's row, as `heldBy` reads it for a claim that holds it. */
type HeldRow = Exclude<Awaited<ReturnType<typeof heldBy>>, { readonly reason: unknown }>;

/** The row, the session's claim holding it, or the claim's refusal thrown. */
const held = async (transaction: Transaction, session: SetupSession): Promise<HeldRow> => {
  const state = await heldBy(transaction, session);
  if ('reason' in state) throw new SetupRefused(state);
  return state;
};

/** Refused unless every step before `step` is passed. Marks the claim's browser seen. */
const inTurn = async (
  executor: Executor,
  session: SetupSession,
  step: SetupStep,
  clock: Clock,
): Promise<void> => {
  if (!reachable(await stepsOf(executor, session, clock), step)) {
    throw new SetupRefused({ reason: 'out-of-order' });
  }
};

/** The first workspace the setup's administrator made: alive, theirs. */
const firstWorkspace = async (
  executor: Executor,
  adminUserId: string | null,
): Promise<Workspace | undefined> => {
  if (adminUserId === null) return undefined;
  const row = await executor
    .selectFrom('workspaces')
    .select(['id', 'name', 'slug', 'avatar_url'])
    .where('created_by', '=', adminUserId)
    .where('deleted_at', 'is', null)
    .orderBy('created_at', 'asc')
    .limit(1)
    .executeTakeFirst();
  return row === undefined
    ? undefined
    : { id: row.id, name: row.name, slug: row.slug, avatarUrl: row.avatar_url };
};

/** The ways in the setup saved after a try that worked and that serve now: what the finish counts. */
const channelsOf = (state: HeldRow, serving: Serving): Serving => ({
  github: state.github_tried_at !== null && serving.github,
  email: state.email_tried_at !== null && serving.email,
});

/** Every reason the finish would be refused now, in the order the wizard meets them. */
const finishProblemsOf = async (
  executor: Executor,
  state: HeldRow,
  serving: Serving,
): Promise<FinishProblem[]> => {
  const problems: FinishProblem[] = [];
  if (state.step_reached !== 'invite') problems.push('out-of-order');
  if ((await firstWorkspace(executor, state.admin_user_id)) === undefined) {
    problems.push('no-workspace');
  }
  const { github, email } = channelsOf(state, serving);
  if (!github && !email) problems.push('no-channel');
  return problems;
};

/** What the browser holding the setup resumes from, besides what the settings and the request say. */
export interface SetupProgress {
  readonly steps: readonly SetupStep[];
  readonly admin: {
    readonly name: string;
    readonly email: string;
    readonly emailVerified: boolean;
  } | null;
  readonly workspace: Workspace | null;
  /** Connected after a try that worked, and serving now: what the finish rule counts. */
  readonly channels: Serving;
  readonly finishProblems: readonly FinishProblem[];
}

export const setupProgress = async (
  executor: Executor,
  session: SetupSession,
  serving: Serving,
  clock: Clock,
): Promise<SetupProgress> =>
  await atomicallyOn(executor)(async (transaction) => {
    const steps = await stepsOf(transaction, session, clock);
    const state = await held(transaction, session);
    const admin =
      state.admin_user_id === null
        ? undefined
        : await transaction
            .selectFrom('users')
            .select(['display_name', 'email', 'email_verified'])
            .where('id', '=', state.admin_user_id)
            .where('deleted_at', 'is', null)
            .executeTakeFirst();
    return {
      steps,
      admin:
        admin === undefined
          ? null
          : { name: admin.display_name, email: admin.email, emailVerified: admin.email_verified },
      workspace: (await firstWorkspace(transaction, state.admin_user_id)) ?? null,
      channels: channelsOf(state, serving),
      finishProblems: await finishProblemsOf(transaction, state, serving),
    };
  });

/** A step that is a confirmation and nothing else: the address seen, the invitations done or skipped, a channel skipped. */
export const passStep = async (
  executor: Executor,
  session: SetupSession,
  step: 'address' | 'invite' | 'github' | 'email',
  clock: Clock,
): Promise<void> => {
  await recordStep(executor, session, step, clock);
};

/** Who may make an account (D-179 §4.7): saved and served at once, then the step recorded. */
export const choosePolicy = async (
  { database, clock, change }: WizardDependencies,
  session: SetupSession,
  signUp: 'invite-only' | 'open',
): Promise<void> => {
  await inTurn(database, session, 'policy', clock);
  await applySettings(database, { signUp }, change);
  await recordStep(database, session, 'policy', clock);
};

/** GitHub's app tried, and — when it worked and `save` says so — kept and served, its step passed. */
export const tryGitHub = async (
  {
    database,
    clock,
    change,
    github,
  }: WizardDependencies & {
    readonly github: Omit<GitHubProbeDependencies, 'timeoutMs'>;
  },
  session: SetupSession,
  candidate: { readonly clientId: string; readonly clientSecret: string },
  save: boolean,
): Promise<ProbeResult> => {
  await inTurn(database, session, 'github', clock);
  const result = await probeGitHub(session, candidate, {
    ...github,
    timeoutMs: GITHUB_PROBE_TIMEOUT_MS,
  });
  if (!result.ok || !save) return result;
  await applySettings(database, { github: candidate }, change);
  await recordChannelTried(database, session, 'github', clock);
  return result;
};

/**
 * The letter the relay is tried with: the administrator's address link, or — the address verified
 * already — a plain test. Made only once the candidate could be tried, so a refused one replaces no link.
 */
const letterForTheAdministrator = async (
  executor: Executor,
  session: SetupSession,
  { appUrl, locale, clock }: { appUrl: string; locale: SignInLocale; clock: Clock },
): Promise<MailMessage> => {
  try {
    const { token, email } = await issueAdminVerification(executor, session, { clock });
    return adminVerificationLetter({ to: email, appUrl, token, locale });
  } catch (error) {
    if (!(error instanceof VerificationRefused)) throw error;
    if (error.refusal.reason === 'no-admin') throw new SetupRefused({ reason: 'out-of-order' });
    const admin = await atomicallyOn(executor)(async (transaction) => {
      const state = await held(transaction, session);
      if (state.admin_user_id === null) return undefined;
      return await transaction
        .selectFrom('users')
        .select('email')
        .where('id', '=', state.admin_user_id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
    });
    if (admin === undefined) throw new SetupRefused({ reason: 'out-of-order' });
    return relayTestLetter({ to: admin.email, appUrl, locale });
  }
};

/** The relay tried with the administrator's letter, and — when it worked and `save` says so — kept. */
export const tryRelay = async (
  {
    database,
    clock,
    change,
    appUrl,
    transportFactory = smtpTransport,
  }: WizardDependencies & {
    readonly appUrl: string;
    readonly transportFactory?: SmtpTransportFactory;
  },
  session: SetupSession,
  candidate: SmtpSettings,
  locale: SignInLocale,
  save: boolean,
): Promise<ProbeResult> => {
  await inTurn(database, session, 'email', clock);
  const refused = candidateRefusal(candidate);
  if (refused !== undefined) throw refused;
  const message = await letterForTheAdministrator(database, session, { appUrl, locale, clock });
  const result = await probeSmtp(session, candidate, message, {
    transportFactory,
    timeoutMs: SMTP_PROBE_TIMEOUT_MS,
  });
  if (!result.ok || !save) return result;
  await applySettings(database, { smtp: candidate }, change);
  await recordChannelTried(database, session, 'email', clock);
  return result;
};

/**
 * The first workspace, the administrator its owner, with `#general` (D-174): made once — `created`
 * false when one was made already, which is then the answer whatever this call asked for.
 */
export const makeFirstWorkspace = async (
  executor: Executor,
  session: SetupSession,
  input: { readonly name: string; readonly slug: string },
  clock: Clock,
): Promise<{ readonly workspace: Workspace; readonly created: boolean }> => {
  await inTurn(executor, session, 'workspace', clock);
  return await atomicallyOn(executor)(async (transaction) => {
    const state = await held(transaction, session);
    if (state.admin_user_id === null) throw new SetupRefused({ reason: 'out-of-order' });
    const made = await firstWorkspace(transaction, state.admin_user_id);
    if (made !== undefined) {
      await recordStep(transaction, session, 'workspace', clock);
      return { workspace: made, created: false };
    }
    const workspace = await createWorkspace(transaction, clock, state.admin_user_id, input);
    await recordStep(transaction, session, 'workspace', clock);
    return { workspace, created: true };
  });
};

/** Finishes the setup if the finish rule allows it now; refuses with every reason otherwise. */
export const finishSetup = async (
  executor: Executor,
  session: SetupSession,
  serving: Serving,
  clock: Clock,
): Promise<void> => {
  await atomicallyOn(executor)(async (transaction) => {
    const state = await held(transaction, session);
    const problems = await finishProblemsOf(transaction, state, serving);
    if (problems.length > 0) throw new FinishRefused(problems);
    await completeSetup(transaction, session, clock);
  });
};
