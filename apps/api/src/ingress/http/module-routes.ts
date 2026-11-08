/**
 * What a module's HTTP routes are handed (D-280, `MODULES.md` §3). A module's handlers and the registration of its routes
 * are a folder of the module, `features/<id>/http/`, and its slot in `bundledModules` (`composition.ts`) holds one function
 * from this context to an Elysia plugin; `createApp` uses every bundled module's plugin in one place and registers none of a
 * module's paths itself. The manifest's `routes` stay the truth about who owns a path, and the route-ownership test holds
 * the plugin to them.
 *
 * The context names what the module's routes use and no more: a module that needs another part of the application widens it
 * here, in a line a reviewer reads, and not by being handed the whole of `Dependencies`.
 */
import type { Executor } from '@purlay/db';
import type { Dependencies } from './app';
import type { Auth } from '../../modules/auth/better-auth';
import type { Clock } from '../../platform/clock';
import type { EventBus } from '../../platform/events';
import type { CredentialCipher } from '../../platform/crypto';
import type { GitHubAppApi, GitHubAppUrls } from '../../platform/github-app-api';
import type { Logger } from '../../platform/logging';
import type { LimiterFactory } from '../../realtime/rate-limiter';
import type { GitHubAppSettings } from '../../modules/setup/settings';
import type { OnlinePresence } from '../../realtime/online';
import type { ModulePorts } from '../../platform/ports/module-ports';
import type { FactPublisher } from '../../platform/ports/fact-publisher';
import type { NotificationSink } from '../../platform/ports/notification-sink';
import type { Atomically } from '../../platform/transactions';
import type { PermissionTable } from '../../platform/module-kit/permissions';

/** What `limiterFor` makes: a bucket, charged by a key. */
export type RouteLimiter = ReturnType<LimiterFactory>;

export interface ModuleRouteDependencies {
  /** Who is calling: every session is resolved through it (`session.ts`). */
  readonly auth: Auth;
  /** The application's database, whose every connection is the module's share (D-266). */
  readonly database: Executor;
  readonly clock: Clock;
  /** What a role may do in a process that runs these modules. */
  readonly permissions: PermissionTable;
  /** What a write tells the sockets through. */
  readonly bus: EventBus;
  /** Who is online on this node and across them (`realtime/online.ts`), for a module that shows presence. */
  readonly online: OnlinePresence;
  /**
   * The ports of the capabilities the module's manifest `uses`, for the workspace of a request: `ports.of(context)` has a port
   * only where its provider runs and the workspace may use it, and `ports.resolveRef(ref, context)` is how a link to another
   * module's record is shown (D-291). Reads through `database`, so in the request's own share.
   */
  readonly ports: ModulePorts;
  /** How a module tells a person something in the core's inbox, inside its own transaction (D-286). */
  readonly inbox: NotificationSink;
  /**
   * How a module tells the build a fact, inside its own transaction and as itself: the publisher is the module whose routes these
   * are, never the caller's choice (D-283 §2). The module must list the type under `publishes`.
   */
  readonly publishFact: FactPublisher;
  /** The transaction boundary a write that tells the sockets runs in, so that it tells them only once committed. */
  readonly atomically: Atomically;
  /** Where a failed publish is written; the write it follows is already committed. */
  readonly log: Logger;
  /** The application's configuration: the addresses GitHub is spoken to at, the client's address rules. */
  readonly config: Dependencies['config'];
  /** The one cipher for stored credentials (D-39 §6), which the core's routes use too. */
  readonly cipher: CredentialCipher;
  /** A limiter by name and budget: shared across nodes where Redis is, in this process where it is not. */
  readonly limiterFor: LimiterFactory;
  /** GitHub's API for unfurling, where a test hands its own; absent, the module makes the real one. */
  readonly githubApi?: Dependencies['githubApi'];
  /** The GitHub App as this request reads it (D-246): the settings' as the holder serves them, or a test's. */
  readonly githubAppSettings: () => GitHubAppSettings | undefined;
  /** How the App's calls reach GitHub, and the addresses it speaks to. */
  readonly githubAppApi: GitHubAppApi;
  readonly githubUrls: GitHubAppUrls;
}
