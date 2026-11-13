/**
 * What the handlers of the HTTP application are made from: the arguments of `createApp`, less the one the composition root
 * alone may type (`Dependencies` in `app.ts` adds `githubApi`, whose type is chat's, and only that file names a module's
 * files, `module-seams.test.ts`). Its own file so the route groups `createApp` composes can name what they are handed
 * without importing the file that imports them.
 */
import type { Executor, LeaseConnection } from '@purlay/db';
import type { Auth } from '../../modules/auth/better-auth';
import type { CompanyTxtLookup } from '../../modules/workspaces/identity/domains';
import type { ServicesPin, SettingsChange } from '../../modules/setup/runtime';
import type { WorkspaceCreators } from '../../modules/workspaces/creators';
import type { WorkspaceChannels } from '../../modules/workspaces/channels-port';
import type { UserErased } from '../../modules/users/erasure';
import type { WorkspaceCreated } from '../../modules/workspaces/workspaces';
import type { GitHubAppSettings } from '../../modules/setup/settings';
import type { ExternalFetch } from '../../modules/images/proxy';
import type { PushSender } from '../../modules/push/sender';
import type { PeersBehind } from '../../modules/entitlements/peers';
import type { Clock } from '../../platform/clock';
import type { Config } from '../../platform/config';
import type { GitHubAppFetch } from '../../platform/github-app-api';
import type { Logger } from '../../platform/logging';
import type { ObjectStore } from '../../platform/storage';
import type { Attention } from '../../platform/attention';
import type { CollatedColumn } from '../../platform/readiness';
import type { ServerMetrics } from '../../platform/metrics';
import type { Backplane } from '../../realtime/bus';
import type { Timers } from '../../realtime/hub';
import type { SharedState } from '../../realtime/shared';
import type { Composition } from '../../composition';
import type { ConnectionLimits } from '../ws/socket';
import type { HttpBudgets } from './rate-limit';
import type { Client } from './client';

export interface HandlerDependencies {
  /** External DNS seam; production uses the bounded system TXT resolver. */
  readonly companyTxtLookup?: CompanyTxtLookup;
  readonly config: Config;
  /**
   * Better Auth (D-179): every session either door sees is resolved through it, over the same
   * database (`sessions.ts`).
   */
  readonly auth: Auth;
  /**
   * Where `auth` is the holder's (`modules/setup/runtime.ts`): what pins, at a request's first hook, the
   * instance and relay the whole request is served by, so a change of the settings while it is in flight
   * lets it finish on the ones it started on (D-179 §4). Absent where `auth` is an instance nothing swaps.
   */
  readonly services?: ServicesPin;
  /**
   * What the setup's steps change the settings through, and the holder whose pair serves now
   * (`applySettings`, D-179 §4.9): the composition root's. Absent where `auth` is an instance nothing
   * swaps — and there the `/setup` routes that read or change the settings fail as a defect.
   */
  readonly settingsChange?: SettingsChange;
  /** A `Kysely` or a `Transaction` — indistinguishable here, which is the point (D-46). */
  readonly database: Executor;
  /**
   * The shares of the pool the modules hold (`moduleConnections`), where the process has something besides requests that
   * takes them — a module's workers (`modules/workers`) are held to the same slots a request of the module is. Absent, the
   * application makes its own, which is all a process with nothing else needs.
   */
  readonly moduleShares?: LeaseConnection;
  readonly clock: Clock;
  /** Where attachment bytes live (D-109); the unconfigured store refuses every use, loudly. */
  readonly storage: ObjectStore;
  /**
   * Starts making an owner's export once its request has committed (D-140): the process's queue
   * (`exportQueue`). A test about something else makes none.
   */
  readonly exportRunner: (exportId: string) => void;
  /** And a person's export of their own data, in the same queue (D-241). */
  readonly personalExportRunner: (exportId: string) => void;
  /**
   * The GitHub App issues are written through (D-246), as this request reads it; absent, the settings' as the
   * holder serves them (`settingsChange`), and without a holder, none. A test hands its own.
   */
  readonly githubApp?: () => GitHubAppSettings | undefined;
  /** How the App's calls reach GitHub; absent, the platform's `fetch`. A test hands its stand-in's. */
  readonly githubAppFetch?: GitHubAppFetch;
  /** Where Google is, as the sign-in is told; absent, Google's own. A test's stand-in. */
  readonly googleIssuer?: string;
  /** How an external image is fetched (#110); absent, the checked one. A test stands its own in. */
  readonly externalFetch?: ExternalFetch;
  readonly log: Logger;
  /** Absent in production, where the limits are the provisional ones (`rate-limit.ts`). */
  readonly rateBudgets?: HttpBudgets;
  /** Absent in production, where the limits are the provisional ones (`rate-limiter.ts`). */
  readonly connectionLimits?: ConnectionLimits;
  /**
   * The transport this node publishes through. One node needs none: it makes its
   * own. Two nodes in one process (a test) share one, which is how a revocation
   * published on either is shown to reach the other's sockets (D-85).
   */
  readonly backplane?: Backplane;
  /**
   * The state nodes share, with `REDIS_URL` (D-201): limiters, typing and who is online. Absent, all of it
   * is in this process, exactly as a self-hosted instance runs it.
   */
  readonly shared?: SharedState;
  /**
   * The built client this node answers for (D-61). Absent in development, where Vite
   * serves it, and in a deployment that puts the API behind something else.
   */
  readonly client?: Client;
  /** Devices told of what needs their person, through both doors; absent where push is off (D-126). */
  readonly push?: PushSender;
  /** Who is in front of a workspace's page now, shared with the push sender it holds back (D-143). */
  readonly attention: Attention;
  /** Presence's grace timers (D-136); a test passes its own, to pass a grace without waiting. */
  readonly timers?: Timers;
  /** The socket liveness sweep's own timers and interval (`realtime/liveness.ts`); absent, the real ones. */
  readonly liveness?: { readonly timers?: Timers; readonly intervalMs?: number };
  /**
   * Who may make a workspace (D-155), read per request; absent, the server's setting
   * (`readWorkspaceCreators`, D-179 §6). A test about something else lets anybody.
   */
  readonly workspaceCreators?: (executor: Executor) => Promise<WorkspaceCreators>;
  /**
   * What the modules start a new workspace with, inside its transaction (D-250); absent, what chat starts
   * one with — its first channel (D-174).
   */
  readonly workspaceCreated?: WorkspaceCreated;
  /** The channels of a workspace, as the workspace code asks for them (D-250); absent, chat's. */
  readonly workspaceChannels?: WorkspaceChannels;
  /** What the modules forget of a person whose account is erased, inside the erasure (D-250); absent, chat's. */
  readonly userErased?: UserErased;
  /**
   * The modules this process runs. Required: a caller that forgot it would silently run every module the build carries,
   * and a path of a module left out is a `404`. The process's own (`index.ts`) is `compositionFor(MODULES)`; a test gets the
   * whole build's from `testDependencies`.
   */
  readonly composition: Composition;
  /** How many live nodes of the cluster do not read workspace grants (D-292); absent where there is one node. */
  readonly peersBehind?: PeersBehind;
  /** How many live nodes of the cluster do not read the modules the administrator has stopped (D-296); absent where there is one node. */
  readonly suspensionPeersBehind?: PeersBehind;
  /** API capability check, in addition to the operator's WORKSPACE_ACCESS_READY attestation (D-310). */
  readonly workspaceAccessPeersBehind?: PeersBehind;
  /** Distinct from policy-only readers; never inferred from their capability or attestation. */
  readonly workspaceProvisioningPeersBehind?: PeersBehind;
  /** What `find` holds a search source to, where a test wants less than `SEARCH_SOURCE_DEADLINE_MS`; a module's own shorter deadline always wins. */
  readonly findDeadlineMs?: number;
  /** The columns the modules declare `COLLATE "C"`, which readiness checks beside the core's (D-250); absent, chat's. */
  readonly collatedColumns?: readonly CollatedColumn[];
  /**
   * The process's one registry (D-221), which the push sender and the mail outbox were handed too;
   * absent, the application keeps one of its own — a test reads it through `/metrics`.
   */
  readonly metrics?: ServerMetrics;
}

/**
 * The dependencies as the handlers receive them: the database leased by the module the request belongs to, and what the
 * modules supply in place of the optional overrides (`createApp`).
 */
export type LeasedDependencies = HandlerDependencies & {
  readonly readAttachment: Composition['readAttachment'];
  readonly workspaceCreated: WorkspaceCreated;
  readonly workspaceChannels: WorkspaceChannels;
  readonly auditAccess: Composition['auditAccess'];
  readonly userErased: UserErased;
  readonly collatedColumns: readonly CollatedColumn[];
};
