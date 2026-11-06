/**
 * The letter's stop link (D-240): `POST /api/missed-mail/stop`, which needs no session — the token in its body is the proof, and
 * the route is charged to the client's address before it is looked at (`rate-limit.ts`). The person's own setting, read and set
 * with their session, is the core's pair of routes (`CORE_ROUTES`) in `ingress/http/missed-mail.ts`.
 */
import { Elysia, type AnyElysia } from 'elysia';
import { StopMissedMailRequest } from '@purlay/types';
import type { ModuleRouteDependencies } from '../../../ingress/http/module-routes';
import { validated } from '../../../ingress/http/validate';
import { stopMissedMail } from '../notifications/missed-mail';

/** `POST /api/missed-mail/stop` — public: `204`, or one `404` for every link that does not open. */
const stopMissedMailByLink = async (
  dependencies: Pick<ModuleRouteDependencies, 'database' | 'clock'>,
  body: unknown,
): Promise<void> => {
  await stopMissedMail(
    dependencies.database,
    dependencies.clock,
    validated(StopMissedMailRequest, body),
  );
};

/** The routes of this file, as the plugin chat's slot supplies (D-280). */
export const missedMailRoutes = (context: ModuleRouteDependencies): AnyElysia =>
  new Elysia().post('/api/missed-mail/stop', async ({ body, set }) => {
    await stopMissedMailByLink(context, body);
    set.status = 204;
    return null;
  });
