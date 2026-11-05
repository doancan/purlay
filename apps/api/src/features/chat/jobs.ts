/**
 * The scheduled jobs of chat (`bun run job <name>`, D-30), named in its manifest: `mail:missed` acts for chat's users
 * and waits for chat to run (`jobs`), and the purge and the sweeps keep chat's rows within their retention in every
 * process (`retention`, `MODULES.md` §2). The core's job runner takes the work from here through the composition and
 * names none of it.
 */
import type { JobWork } from '../../modules/jobs/jobs';
import { purgeRetention } from './messages/retention-purge';
import { mailMissedMessages } from './notifications/missed-mail';
import { sweepGitHubDeliveries, sweepLinkPreviews } from './sweeps';

export const chatJobWork: Readonly<Record<string, JobWork>> = {
  'purge:retention': async ({ database, clock, log, storage }) =>
    await purgeRetention({ database, clock, log, storage }),
  'sweep:link-previews': async ({ database, clock }) =>
    await sweepLinkPreviews({ database, clock }),
  'sweep:github-deliveries': async ({ database, clock }) =>
    await sweepGitHubDeliveries({ database, clock }),
  'mail:missed': async ({ database, clock, log, appUrl, withMailer }) =>
    await withMailer(
      async (send) => await mailMissedMessages({ database, clock, log, send, appUrl }),
    ),
};
