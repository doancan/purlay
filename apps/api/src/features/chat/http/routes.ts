/**
 * The routes of chat (D-280): the plugin of its slot in `bundledModules`, made of the plugins of its resources, each in
 * the file that holds the handlers. A resource joins here as its handlers move out of `ingress/http/` and its routes out of
 * `app.ts`; `HTTP_IN_INGRESS` in `route-ownership.test.ts` is the list of modules that still have some there.
 */
import { Elysia, type AnyElysia } from 'elysia';
import type { ModuleRouteDependencies } from '../../../ingress/http/module-routes';
import { bookmarkRoutes } from './bookmarks';
import { hiddenRoutes } from './hidden';
import { pinRoutes } from './pins';
import { reactionRoutes } from './reactions';
import { savedRoutes } from './saved';
import { incidentRoutes } from './incidents';
import { knowledgeRoutes } from './knowledge';
import { notificationRoutes } from './notifications';
import { presenceRoutes } from './presence';
import { reminderRoutes } from './reminders';
import { scheduledRoutes } from './scheduled';
import { starRoutes } from './star';
import { versionRoutes } from './versions';

export const chatRoutes = (context: ModuleRouteDependencies): AnyElysia =>
  new Elysia()
    .use(bookmarkRoutes(context))
    .use(hiddenRoutes(context))
    .use(pinRoutes(context))
    .use(reactionRoutes(context))
    .use(savedRoutes(context))
    .use(incidentRoutes(context))
    .use(knowledgeRoutes(context))
    .use(notificationRoutes(context))
    .use(presenceRoutes(context))
    .use(reminderRoutes(context))
    .use(scheduledRoutes(context))
    .use(starRoutes(context))
    .use(versionRoutes(context));
