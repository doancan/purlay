# D-251. Sign in with Google, as a way in of its own — builds on D-31, D-138, D-179, D-200, D-239

**Context.** A person with a Google account and no wish to use GitHub had two ways in: a link by email, and the one
generic single-sign-on slot of D-200 — which a server gives to its organisation's provider (Okta, Entra ID), and which
holds one provider at a time. Google is where most of those people already are. The work is not the screen but three
questions D-200 answered for a provider the operator chose and which are open again for one that every Google account
holder can reach: which addresses Google may vouch for, what becomes of an account made by email once its owner comes
in through Google, and whether a mailbox is a second door past a provider. Google does not open the server to
everybody who can press the button: who is let in is still decided by the invitation passport, the sign-up policy and
`WORKSPACE_CREATORS`.

**Decision.** Google is a provider the server knows by name, `google`, with its own routes, its own settings and its
own way of being believed — and the checks are D-200's, not a second copy of them.

1. **One verification core, two definitions.** `createOidcProvider` (`modules/auth/oidc.ts`) takes an
   `OidcDefinition`: a provider id, the messages of its refusals, an optional `acceptedIssuers` and an optional
   admission rule. The generic provider's definition is what D-200 shipped, byte for byte, and every test of it passes
   unchanged. Google's is fixed: issuer `https://accounts.google.com`, scopes exactly `openid email profile`, code
   with PKCE, the `id_token` the only identity, no `picture` taken (D-200 §7), no discovery until somebody presses the
   button or an administrator probes. `acceptedIssuers` lists only the *extra* spellings of a token's `iss` — Google
   sends `accounts.google.com` as well, and says to accept both — and the configured issuer is always accepted; the
   generic provider has none and keeps exact equality. `messages` gives Google its own refusal wording; the single
   sign-on sentences are unchanged.
2. **Who an account is.** `accounts.provider_id = 'google'`, `accounts.account_id = <sub>`, with no issuer prefix: the
   issuer is fixed, and an `iss` that arrives in two spellings would make a prefixed key inconsistent. A person whose
   `sub` is already linked signs in to its owner **whatever address the token carries now** — the subject decides, not
   the address, as D-200 §3 — and `users.email` is never rewritten from Google's side. Routes are
   `GET /auth/google` and `GET /auth/callback/google`; with Google not connected neither answers (`404
   ROUTE_NOT_FOUND`), and `AuthMethods.google` is `false`.
3. **When an existing account is linked by address.** Only if the token says `email_verified` and the account's own
   `email_verified` is true (D-179 §5, D-200 §3) **and the address is one Google may vouch for**
   (`authoritativeForGoogle`): its domain is `gmail.com` or `googlemail.com`, or the token carries `hd` and the
   address's domain is exactly that `hd` (a subdomain is another domain; case does not count). A verified address at
   any other domain is Google's word about a mailbox it does not run: the domain may have changed hands, and a
   person who registered a Google account on it would be signed in as the person it was. That is refused as
   `email-unverified`, and nothing is written. **No account at the address** is a sign-up and follows the server's own
   rules, so a newcomer at an outside address may sign up: the question was never whether Google may vouch for
   somebody's mailbox but whether it may be used to take another person's account. **The same rule says what an
   account Google makes keeps**: `users.email_verified` is true only where the address is Google's to vouch for
   (`OidcDefinition.emailVerified`, which the generic provider leaves out and so always tells the library `true`). An
   account Google made at an outside address is therefore not one GitHub or single sign-on links into by that address
   — the library's own gate refuses it (`email-taken`) — and nobody who later holds the address takes it that way;
   Google signs it in by the `sub` as any other.
4. **An account Google made is marked.** `users.google_made` (migration 0078) is set in the sign-up that Google's
   callback makes, and nowhere else; an account made by email and later linked to Google keeps it false. It is the
   same distinction `github_id` carries for GitHub's, and it is what §6 needs.
5. **One identity, and not a way past single sign-on.** An account has one Google identity: a second `sub` carrying the
   address of an account Google is already linked to is refused (`identity_conflict`), never added beside the first.
   An account that has an `oidc` account row is not linked to Google by address either (`identity_conflict`), as
   GitHub is not (D-200 §6): the provider that decides who still works there is not bypassed. The check is one
   (`refusedIdentityConflict`) for the three providers.
6. **A Google-made account is not sent a link while Google is connected.** The address's letter is the word "use
   Google" (English and Turkish, `sign-in-letters.ts`) instead of a link, asked and answered `202` as for any
   address, and a link already sent is refused when spent (`fateOf` is asked again). An account made by email keeps
   its links when Google is later linked to it. Disconnect Google and the links return, so nobody is shut out by a way
   in that is gone. *Accepted:* with Google down, a Google-made account has no fallback but its other ways in.
7. **Configuration and the administrator's say, as GitHub's and single sign-on's are.** `GOOGLE_CLIENT_ID` and
   `GOOGLE_CLIENT_SECRET` are a seed, read on the first start only: both or neither, or the server refuses to start;
   the secret is sealed bound to its column name and redacted in logs. Afterwards `POST` and `DELETE /api/server/google`
   (Administration → Server): the pair is **tried before it is kept** — the discovery document, the key set, and the
   token endpoint sent the credentials with a code nobody was given — and kept only when it works. A non-admin gets
   `404`, like every other administrator route. Google counts as a way in for the last-way-in rule
   (`confirmLastChannel`) and for turning passwords off (D-239): the last provider is not disconnected while passwords
   are off. Connecting and disconnecting are on the audit trail as `server.google_connected` and
   `server.google_disconnected`, written in the saving transaction, never a value.
8. **The setup wizard has no step for it**, as it has none for single sign-on (D-200 §4): the first person is set up
   with a way in that proves who they are, and Google is connected from Administration → Server or by the seed on the
   first start.
9. **The button.** Order on the sign-in, sign-up and invitation screens: single sign-on (if connected), GitHub, Google,
   email. *Continue with Google* / *Google ile devam et*, with Google's multicolour "G" drawn as an inline SVG in the
   icon set and its four colours as brand tokens, the same in every theme (D-97). Nothing is loaded from Google by the
   browser (D-39). The reasons that reach the person are the closed set of D-121; Google adds none.
10. **No contract bump.** `AuthMethods.google` and the new paths are additions (D-186).

**Rejected.**

- *Google in the generic OIDC slot.* It would leave nothing for an organisation's own provider, allow one of the two
  and not both, and make the "who vouches for this address" rule a property of whichever issuer is typed in.
- *`hd` as a restriction on who may enter* (`only @company.com`). D-200 refused an allow-list: who may come in is the
  invitation, the sign-up policy and `WORKSPACE_CREATORS`. Here `hd` only says whose domain an address is, for §3. A
  restriction can be added without changing any of this.
- *Trusting every verified address* — linking an existing account whenever Google says `email_verified`. Google
  can vouch for an address at a domain it does not run only as far as it was once reached; a domain that changes
  hands makes that a claim over somebody else's account (§3).
- *A link for a Google-made account.* A second door past the way it was made in, and one that would let an account
  Google created be taken by whoever holds the mailbox when Google is the provider the person chose (D-200 §6's
  reasoning, as GitHub's). *Refusing links for every linked account* was rejected the other way: an account made by
  email would lose its fallback because Google was added.
- *Several OIDC slots.* A table, an ordering and a settings screen to choose between providers, for a need Google
  alone raises; the fixed provider is smaller and nothing blocks the slots from being added.
- *A monochrome mark.* Google's brand rules for the button ask for the multicolour "G"; a grey one is a button that
  looks disabled beside GitHub's.
- *A step in the setup wizard.* As for single sign-on (D-200): three screens for a way in set up after the first person
  has signed in; the seed covers a one-command install.
- *Taking the profile picture or reading the userinfo endpoint.* D-200 §7 and §2: an address of somebody else's every
  viewer's browser would be sent to, and an unsigned answer.

**Accepted.** A person whose `hd`-less address is outside Gmail cannot link an existing account by Google, and is told
`email-unverified`: they sign in the way the account was made, or an administrator invites them. A Workspace address
whose `hd` is missing from the token is treated as outside Gmail. An account Google made at an outside address has an
unproven address (§3): it is signed into by Google alone, is sent no sign-in letter (`fateOf` answers nothing for an
unproven address, as for any) — so with Google disconnected it has no way in of its own, unlike one at a Gmail or `hd`
address, which gets its links back (§6) — and GitHub or single sign-on refuses it as `email-taken`. An account Google made at a
Gmail or `hd` address is proven, so GitHub or single sign-on carrying the same verified address links into it, as
either links into an account GitHub made. That order is not blocked: Google is refused an account single sign-on is
linked to (§5), but single sign-on is not refused an account Google is linked to. Google may show an unpublished OAuth client only to
its test users; the operator note in `CONFIG.md` says to publish it.

**Cost of reversing.** Disconnect Google (`DELETE /api/server/google`) and no route answers, the button disappears and
Google-made accounts are sent links again. Dropping the way in is that, the Google branches in
`better-auth.ts`, `magic-link.ts` and `server-admin.ts`, and a migration that drops `google_client_id`,
`google_client_secret_encrypted` and `users.google_made`; accounts' `provider_id = 'google'` rows are deleted with it.
