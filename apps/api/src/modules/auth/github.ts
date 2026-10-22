/**
 * What GitHub says about an account, as the rest of the sign-in reads it.
 *
 * The calls themselves are the sign-in library's (`better-auth.ts`, D-179): it redeems the code and
 * asks for the profile and the addresses, and this module keeps only the shapes those answers are
 * cleaned into. **Scopes are `read:user user:email` and nothing more.** Repository access belongs to
 * the workspace-level integration token, never to a member's sign-in (D-23, D-38); the authorization
 * address is the library's, its default is these two, and `sign-in.e2e.ts` reads them off it.
 */

export interface GitHubProfile {
  /** The stable identity. A login can be renamed and re-taken; this cannot. */
  readonly id: number;
  readonly login: string;
  readonly name: string | null;
  readonly avatarUrl: string | null;
}
