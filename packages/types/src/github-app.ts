/**
 * GitHub issues from conversations (D-246, `PRD.md` §4 Phase 2): the server's GitHub App, a workspace's
 * installation of it, and a person's own authorization to write as themselves.
 *
 * Two credentials, never mixed. What every member of a channel sees — a card, a link's state — is read with
 * the workspace's (its token, D-23, or the App's installation); what one person does on GitHub is done with
 * that person's own App user access token, so it can reach only the repositories both they and the App can.
 */
import { Type, type Static } from '@sinclair/typebox';
import { FromClient, Timestamp } from './models';

/**
 * Where GitHub sends a browser back after an installation or an authorization: the App's one callback URL, to
 * be registered on GitHub with "Request user authorization (OAuth) during installation" on.
 */
export const GITHUB_APP_CALLBACK = '/api/github-app/callback';
/** Where the App's deliveries are sent: its one webhook URL. */
export const GITHUB_APP_WEBHOOK = '/api/webhooks/github-app';

/** GitHub's App slug: the part of `github.com/apps/<slug>`. */
export const GITHUB_APP_SLUG_PATTERN = '^[a-z0-9][a-z0-9-]{0,63}$';
export const GITHUB_APP_CLIENT_ID_MAX = 128;
export const GITHUB_APP_CLIENT_SECRET_MAX = 256;
/** A PEM RSA key GitHub generates is about 1.7 KB; room for a 4096-bit one and its armour. */
export const GITHUB_APP_PRIVATE_KEY_MAX = 8192;
export const GITHUB_APP_WEBHOOK_SECRET_MAX = 256;

/**
 * `POST /api/server/github-app` — the App, as GitHub's settings page shows it: its id, its slug, its client
 * id and secret, the private key it generated and the webhook secret it was given. Tried before it is kept.
 */
export const ServerGitHubAppRequest = FromClient({
  appId: Type.Integer({ minimum: 1, maximum: 9_999_999_999 }),
  slug: Type.String({ pattern: GITHUB_APP_SLUG_PATTERN }),
  clientId: Type.String({ minLength: 1, maxLength: GITHUB_APP_CLIENT_ID_MAX }),
  clientSecret: Type.String({ minLength: 1, maxLength: GITHUB_APP_CLIENT_SECRET_MAX }),
  privateKey: Type.String({ minLength: 1, maxLength: GITHUB_APP_PRIVATE_KEY_MAX }),
  webhookSecret: Type.String({ minLength: 1, maxLength: GITHUB_APP_WEBHOOK_SECRET_MAX }),
});
export type ServerGitHubAppRequest = Static<typeof ServerGitHubAppRequest>;

/** The App as a response may carry it: never a secret, only that each is set. */
export interface GitHubAppView {
  readonly appId: number;
  readonly slug: string;
  readonly clientId: string;
  readonly clientSecret: { readonly set: boolean };
  readonly privateKey: { readonly set: boolean };
  readonly webhookSecret: { readonly set: boolean };
}

/** Where the App's own settings on GitHub must point: its callback and its webhook. */
export interface GitHubAppAddresses {
  readonly callbackUrl: string;
  readonly webhookUrl: string;
}

/**
 * `GET /api/workspaces/:workspaceId/github-app` — any member: whether the server has an App at all (without one
 * nothing of this is offered), the workspace's installation, and the caller's own authorization.
 */
export const GitHubAppStatus = Type.Object({
  available: Type.Boolean(),
  installation: Type.Union([
    Type.Object({
      accountLogin: Type.String({ minLength: 1, maxLength: 39 }),
      accountType: Type.Union([Type.Literal('User'), Type.Literal('Organization')]),
      suspended: Type.Boolean(),
      connectedAt: Timestamp,
    }),
    Type.Null(),
  ]),
  authorization: Type.Union([
    Type.Object({ login: Type.String({ minLength: 1, maxLength: 39 }) }),
    Type.Null(),
  ]),
});
export type GitHubAppStatus = Static<typeof GitHubAppStatus>;

/** Where the browser goes next: GitHub's installation or authorization screen. */
export const GitHubAppRedirect = Type.Object({ url: Type.String({ minLength: 1 }) });
export type GitHubAppRedirect = Static<typeof GitHubAppRedirect>;

/** The longest path a person is brought back to after authorizing. */
export const GITHUB_RETURN_TO_MAX = 512;

/**
 * `POST /api/github-app/authorization` — where in the app to come back to: a path of this origin, never an
 * address of another (`//host` is one).
 */
export const GitHubAuthorizationRequest = FromClient({
  returnTo: Type.String({
    minLength: 1,
    maxLength: GITHUB_RETURN_TO_MAX,
    pattern: '^/(?![/\\\\])[^\\s]*$',
  }),
});
export type GitHubAuthorizationRequest = Static<typeof GitHubAuthorizationRequest>;

/**
 * What the callback says to the page it returns to, as `?github=` (never a code or a token): connected or
 * authorized, or why not.
 */
export const GITHUB_CALLBACK_OUTCOMES = [
  'connected',
  'authorized',
  'expired',
  'refused',
  'not-yours',
  'unavailable',
] as const;
export type GitHubCallbackOutcome = (typeof GITHUB_CALLBACK_OUTCOMES)[number];

/** What became of a delivery to the App's address, as GitHub is told (`2xx`). */
export const GitHubAppDeliveryAnswer = Type.Object({
  outcome: Type.Union([
    Type.Literal('applied'),
    Type.Literal('ignored'),
    Type.Literal('duplicate'),
    Type.Literal('pinged'),
  ]),
});
export type GitHubAppDeliveryAnswer = Static<typeof GitHubAppDeliveryAnswer>;
