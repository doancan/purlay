/**
 * Email about what a person missed (D-240), over HTTP, all of it chat's (D-280): the caller's own setting, read and set with
 * their session (`GET` and `PUT /api/me/missed-mail`), and the letter's stop link (`POST /api/missed-mail/stop`), which needs
 * no session — the token in its body is the proof, and the route is charged to the client's address before it is looked at
 * (`rate-limit.ts`). With chat not run, none of the three is a route.
 * Whether the server can send mail is whether the sign-in library has a relay to send through, read per request, so a relay
 * added in the settings counts at once.
 */
import { Elysia, type AnyElysia } from 'elysia';
import { SetMissedMailRequest, StopMissedMailRequest, type MissedMailSetting } from '@purlay/types';
import type { ChatRouteDependencies } from './dependencies';
import { requireSession } from '../../../ingress/http/session';
import { validated } from '../../../ingress/http/validate';
import type { SessionAuth } from '../../../modules/auth/sessions';
import { readMissedMail, setMissedMail, stopMissedMail } from '../notifications/missed-mail';

const mailOn = (auth: SessionAuth): boolean => auth.signInLinksOn;

/** `GET /api/me/missed-mail` — whether the caller asked to be mailed, and whether this server can. */
const readMyMissedMail = async (
  dependencies: Pick<ChatRouteDependencies, 'auth' | 'database'>,
  request: Request,
): Promise<MissedMailSetting> => {
  const { userId } = await requireSession(dependencies.auth, request);
  return await readMissedMail(dependencies.database, userId, mailOn(dependencies.auth));
};

/** `PUT /api/me/missed-mail` — turns the caller's own letters on or off. */
const setMyMissedMail = async (
  dependencies: Pick<ChatRouteDependencies, 'auth' | 'database' | 'clock'>,
  request: Request,
  body: unknown,
): Promise<MissedMailSetting> => {
  const { userId } = await requireSession(dependencies.auth, request);
  return await setMissedMail(
    dependencies.database,
    dependencies.clock,
    userId,
    validated(SetMissedMailRequest, body),
    mailOn(dependencies.auth),
  );
};

/** `POST /api/missed-mail/stop` — public: `204`, or one `404` for every link that does not open. */
const stopMissedMailByLink = async (
  dependencies: Pick<ChatRouteDependencies, 'database' | 'clock'>,
  body: unknown,
): Promise<void> => {
  await stopMissedMail(
    dependencies.database,
    dependencies.clock,
    validated(StopMissedMailRequest, body),
  );
};

/** The routes of this file, as the plugin chat's slot supplies (D-280). */
export const missedMailRoutes = (context: ChatRouteDependencies): AnyElysia =>
  new Elysia()
    .get('/api/me/missed-mail', async ({ request }) => await readMyMissedMail(context, request))
    .put(
      '/api/me/missed-mail',
      async ({ request, body }) => await setMyMissedMail(context, request, body),
    )
    .post('/api/missed-mail/stop', async ({ body, set }) => {
      await stopMissedMailByLink(context, body);
      set.status = 204;
      return null;
    });
