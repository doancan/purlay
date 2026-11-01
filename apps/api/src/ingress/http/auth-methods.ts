/**
 * How this server signs people in (#81, D-138 §6), asked before anybody is: the sign-in screen offers
 * only what works. GitHub where an app is connected; single sign-on where a provider is (D-200); email when the server can send a link — when the
 * instance, built from the server's settings (D-179 §6), has a relay to mail one through. A server with
 * neither is waiting for its setup (D-179 §4), and says so with two `false`. `signUp` is who may make
 * an account (R51): the sign-in screen offers "Create an account" under `open` only. `password` is whether the
 * address and password sign in, `false` where the administrator turned it off (D-239).
 */
import type { AuthMethods } from '@purlay/types';
import type { Auth } from '../../modules/auth/better-auth';

/** `GET /api/auth/methods` — nothing of anybody in it: the same for every caller. */
export const authMethods = (
  auth: Pick<Auth, 'signInLinks' | 'github' | 'oidc' | 'signUp' | 'signInPolicy'>,
): AuthMethods => ({
  github: auth.github,
  email: auth.signInLinks !== undefined,
  oidc: auth.oidc === undefined ? null : { name: auth.oidc.name ?? null },
  signUp: auth.signUp,
  password: auth.signInPolicy.passwordSignIn,
});
