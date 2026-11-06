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
import type { Auth } from '../../modules/auth/better-auth';
import type { Clock } from '../../platform/clock';
import type { PermissionTable } from '../../platform/module-kit/permissions';

export interface ModuleRouteDependencies {
  /** Who is calling: every session is resolved through it (`session.ts`). */
  readonly auth: Auth;
  /** The application's database, whose every connection is the module's share (D-266). */
  readonly database: Executor;
  readonly clock: Clock;
  /** What a role may do in a process that runs these modules. */
  readonly permissions: PermissionTable;
}
