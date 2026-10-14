/**
 * How this server signs people in (#81, D-138 §6), asked before anybody is: the sign-in screen offers
 * only what works. GitHub always; email when the server can send a link — both of `SMTP_URL` and
 * `MAIL_FROM`, which the configuration refuses one without the other.
 */
import type { AuthMethods } from '@purlay/types';
import type { Config } from '../../platform/config';

/** `GET /api/auth/methods` — nothing of anybody in it: the same for every caller. */
export const authMethods = (config: Pick<Config, 'SMTP_URL' | 'MAIL_FROM'>): AuthMethods => ({
  email: config.SMTP_URL !== undefined && config.MAIL_FROM !== undefined,
});
