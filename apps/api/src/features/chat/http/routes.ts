/**
 * The routes of chat (D-280): the plugin of its slot in `bundledModules`, made of the plugins of its resources, each in
 * the file that holds the handlers. A resource of chat is added here and nowhere in `ingress/http/app.ts`;
 * `route-ownership.test.ts` fails for a path of chat's that `app.ts` registers.
 */
import { Elysia, type AnyElysia } from 'elysia';
import type { ModuleRouteDependencies } from '../../../ingress/http/module-routes';
import { bookmarkRoutes } from './bookmarks';
import { channelRoutes } from './channels';
import { hiddenRoutes } from './hidden';
import { feedRoutes } from './feeds';
import { githubAppRoutes } from './github-app';
import { githubIntegrationRoutes } from './github-integration';
import { githubIssueRoutes } from './github-issues';
import { integrationRoutes } from './integrations';
import { webhookRoutes } from './webhooks';
import { incomingWebhookRoutes } from './incoming-webhooks';
import { messageRoutes } from './messages';
import { missedMailRoutes } from './missed-mail';
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
import { githubWiring } from './wiring';

export const chatRoutes = (context: ModuleRouteDependencies): AnyElysia => {
  const wiring = githubWiring(context);
  return new Elysia()
    .use(bookmarkRoutes(context))
    .use(channelRoutes(context))
    .use(messageRoutes(context))
    .use(missedMailRoutes(context))
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
    .use(feedRoutes(context))
    .use(githubAppRoutes(context, wiring))
    .use(githubIntegrationRoutes(context, wiring))
    .use(githubIssueRoutes(context, wiring))
    .use(integrationRoutes(context, wiring))
    .use(webhookRoutes(context, wiring))
    .use(incomingWebhookRoutes(context, wiring))
    .use(versionRoutes(context));
};
