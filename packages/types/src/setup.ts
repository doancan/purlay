/**
 * The steps of the setup in the browser (D-179 §4), in the order the wizard walks them.
 *
 * Both halves read them from here: the server records how far a claimed setup has come and refuses a
 * step out of order, and the wizard resumes at the first step not yet passed — so the names and the
 * order cannot drift between them. A step skipped (GitHub, mail) is still a step passed.
 *
 * A plain list rather than a TypeBox union: no request carries a step — each step has a route of its
 * own (`API.md` §2, `/setup/*`) — and a schema built by calls at the top of a module stays in the
 * browser's bundle whether anything reads it or not (measured).
 */
export const SETUP_STEPS = [
  /** The setup code was accepted and the setup bound to this browser. */
  'claim',
  /** The administrator: name, address and password. */
  'admin',
  /** The server's address, confirmed (Ruling R35). */
  'address',
  /** Who may sign up: invite-only or open — chosen on the address's screen (`UX.md` §11, step 3). */
  'policy',
  /** GitHub's OAuth app, tried before it is kept, or skipped. */
  'github',
  /** The mail relay, tried before it is kept, or skipped. */
  'email',
  /** The first workspace. */
  'workspace',
  /** The first invitations, or a link to copy. */
  'invite',
  /** Finishing: refused until a way for other people to sign in is connected and was tried (§4.5). */
  'finish',
] as const;

export type SetupStep = (typeof SETUP_STEPS)[number];

/**
 * Why a try of GitHub's app or of a mail relay failed (D-179 §4.4): a closed set, each produced by the
 * probe (`modules/setup/probes.ts`) and each given its own sentence by the wizard (`UX.md` §11). A plain
 * list for the same reason as `SETUP_STEPS`.
 *
 * Not here: a callback address GitHub would refuse. Only a browser's round trip through GitHub's
 * authorize screen meets that check, so no probe can produce it; the wizard shows the address to paste
 * instead (Ruling R47).
 */
export const PROBE_REASONS = [
  /** GitHub knows the app and refused the secret given with it (`incorrect_client_credentials`). */
  'secret-rejected',
  /** GitHub knows no app by that client id (measured: `404`, `{"error":"Not Found"}`). */
  'client-unknown',
  /** Nothing answered: no such host, the port closed, or no reply within the bound. */
  'unreachable',
  /** Reached, and the secure connection failed: an untrusted certificate, or no TLS where it is required. */
  'tls-failed',
  /** The relay refused the login. */
  'auth-failed',
  /** The relay took the login and refused the sender's address. */
  'sender-refused',
  /** The relay refused the recipient's address. */
  'recipient-refused',
  /** The relay took both addresses and refused the message itself. */
  'message-refused',
  /** An answer that is not the service's: a page that is not GitHub, a greeting that is not SMTP. */
  'unexpected-reply',
  /** The provider's discovery document names another issuer than the one given (D-200 §2). */
  'issuer-mismatch',
  /** Reached, and what it answers is not an OpenID Connect provider this server can sign in with (D-200 §2). */
  'discovery-invalid',
] as const;

export type ProbeReason = (typeof PROBE_REASONS)[number];

/**
 * A try's outcome. `raw` is what the service answered, trimmed, at most 200 characters, with every
 * credential that was tried taken out of it — shown to the operator under the reason's sentence.
 */
export type ProbeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: ProbeReason; readonly raw: string };

/**
 * Why the setup cannot be finished yet (D-179 §4.5), every one that holds, so the wizard can say each:
 *
 * - `out-of-order` — a step before the finish is not passed yet (the invitations, skipped or not, are
 *   the last);
 * - `no-workspace` — the first workspace is not there;
 * - `no-channel` — no way for other people to sign in is connected and was tried: neither a GitHub app
 *   that GitHub accepted when it was saved, nor a relay that took the test letter when it was saved,
 *   is serving now (Ruling R47).
 */
export const FINISH_PROBLEMS = ['out-of-order', 'no-workspace', 'no-channel'] as const;

export type FinishProblem = (typeof FINISH_PROBLEMS)[number];

/** Why a step was refused to the browser holding the setup (`409 SETUP_STEP_REFUSED`). */
export type SetupStepRefusal = FinishProblem | 'admin-exists';

/**
 * The server's settings as a response may carry them (D-179 §6): a secret is whether it is set, the
 * relay's address is its scheme, host and port alone, and no field could hold a secret.
 */
export interface ServerSettingsView {
  readonly signUp: 'invite-only' | 'open';
  /** Whether an account that signs in with a password must turn on two-step verification (D-239). */
  readonly requireTwoFactor: boolean;
  /** Whether an address and a password sign in at all; off only while GitHub or single sign-on is (D-239). */
  readonly passwordSignIn: boolean;
  readonly github: {
    readonly clientId: string;
    readonly clientSecret: { readonly set: boolean };
  } | null;
  /** The single sign-on provider (D-200): where it is, who this server is to it, never the secret. */
  readonly oidc: {
    readonly issuer: string;
    readonly clientId: string;
    readonly clientSecret: { readonly set: boolean };
    /** What the sign-in button says; `null` is the default, `Single sign-on`. */
    readonly name: string | null;
  } | null;
  readonly smtp: {
    /** That a relay is set, and where; never its user, never its password. */
    readonly address: { readonly set: true; readonly host: string };
    readonly from: string;
    readonly allowPlaintext: boolean;
  } | null;
  readonly workspaceCreators:
    | { readonly kind: 'first' | 'anyone' }
    | { readonly kind: 'listed'; readonly logins: readonly string[] };
  readonly setupCompletedAt: string | null;
}

/**
 * `GET /setup/status` — public, and the same for everybody: whether this server is open to setup, and
 * the address it is configured for (`APP_URL`, Ruling R35) — which the setup page compares with its own
 * origin before a code is sent, since a claim from another origin is refused as cross-site.
 */
export interface SetupStatus {
  readonly open: boolean;
  readonly appUrl: string;
}

/**
 * `GET /setup/state` — what the browser holding the setup resumes from. Only ever the holder's: every
 * other caller is `404 SETUP_UNAVAILABLE`.
 */
export interface SetupState {
  /** The steps passed, in order: the wizard resumes at the first one not in it. */
  readonly steps: readonly SetupStep[];
  /** The server's address (`APP_URL`), from its environment (Ruling R35). */
  readonly appUrl: string;
  /** The callback address to paste into GitHub's app: `APP_URL/auth/callback/github`. */
  readonly githubCallbackUrl: string;
  /** The settings now, as a response may carry them. */
  readonly settings: ServerSettingsView;
  /** The secrets a rotated `ENCRYPTION_KEY` left unreadable: read as unset until entered again. */
  readonly needsReentry: readonly ('github' | 'smtp' | 'oidc')[];
  /**
   * The ways for other people to sign in that are connected and were tried when saved, and serve now:
   * what the finish rule counts (D-179 §4.5).
   */
  readonly channels: { readonly github: boolean; readonly email: boolean };
  /** The administrator, once made: the address is theirs, so the holder may see it. */
  readonly admin: {
    readonly name: string;
    readonly email: string;
    readonly emailVerified: boolean;
  } | null;
  /** The first workspace, once made. */
  readonly workspace: { readonly id: string; readonly name: string; readonly slug: string } | null;
  /** Whether `POST /setup/finish` would be accepted now; when not, every reason. */
  readonly canFinish: boolean;
  readonly finishProblems: readonly FinishProblem[];
}

/** `POST /setup/admin` — whether the administrator, made, was also signed in (its cookie came back). */
export interface SetupAdminAnswer {
  readonly signedIn: boolean;
}

/** `POST /setup/verify` — the administrator's address is verified. */
export interface SetupVerifyAnswer {
  readonly verified: true;
}

/**
 * `GET /api/server/settings` — Administration → Server's page (D-179 §4.8): the settings as a response
 * may carry them, which secrets need entering again, the addresses the page shows, and which ways in
 * serve now. Never a secret.
 */
export interface ServerSettingsAnswer {
  readonly settings: ServerSettingsView;
  readonly needsReentry: readonly ('github' | 'smtp' | 'oidc')[];
  readonly appUrl: string;
  readonly githubCallbackUrl: string;
  /** The callback address to register with the single sign-on provider: `APP_URL/auth/callback/oidc` (D-200). */
  readonly oidcCallbackUrl: string;
  /** Which ways for other people to sign in serve now. */
  readonly channels: {
    readonly github: boolean;
    readonly email: boolean;
    readonly oidc: boolean;
  };
  /** The caller's own address: where the relay's test letter goes. */
  readonly adminEmail: string;
}
