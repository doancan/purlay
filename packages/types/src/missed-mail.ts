/**
 * Email about what a person missed (D-240): one letter, at most one an hour, about the mentions and direct
 * messages that waited unread for them past a quarter of an hour. Off until the person turns it on, and offered
 * only where the server can send mail. The letter carries a link that turns it off without signing in.
 */
import { Type, type Static } from '@sinclair/typebox';
import { FromClient } from './models';

/** `GET` and `PUT /api/me/missed-mail` — whether it is on, and whether this server can send mail at all. */
export const MissedMailSetting = Type.Object({
  on: Type.Boolean(),
  available: Type.Boolean(),
});
export type MissedMailSetting = Static<typeof MissedMailSetting>;

/** `PUT /api/me/missed-mail` — on or off. On is refused where the server sends no mail. */
export const SetMissedMailRequest = FromClient({ on: Type.Boolean() });
export type SetMissedMailRequest = Static<typeof SetMissedMailRequest>;

/**
 * `POST /api/missed-mail/stop` — the token a letter's link carried in its fragment, posted by the page that read
 * it; never in a path, so never in a log.
 */
export const StopMissedMailRequest = FromClient({
  token: Type.String({ pattern: '^[0-9a-f]{64}$' }),
});
export type StopMissedMailRequest = Static<typeof StopMissedMailRequest>;
