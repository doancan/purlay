/** What chat's routes are handed: the application's context, with the database as chat's own tables (D-271, D-280). */
import type { ModuleRouteDependencies } from '../../../ingress/http/module-routes';
import type { ChatDb } from '../schema';

export type ChatRouteDependencies = ModuleRouteDependencies<ChatDb>;
