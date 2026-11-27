# D-200. Single sign-on by OpenID Connect, as a third way in — builds on D-31, D-138, D-179, D-191; closes #88

**Context.** D-31 moved SSO from a permanent non-goal to "OIDC, only if an operator asks", and D-179 made the library
that owns identity one that can do it. The condition is gone: an organisation with an identity provider is the
customer the audit log (D-26) and the capacity ceiling (D-25) were written for, and a way in that is built after
somebody asks is one built under a deadline. The cost is a security decision, not a screen: a provider that is
believed too easily is an account takeover for everyone on the server. SAML stays refused (D-31, `PRD.md` §6).

**Decided.**

1. **Authorization code with PKCE, `openid email profile`, and the `id_token` as the only identity.** The browser is
   sent to the provider by `GET /auth/oidc` with the library's `state` (its row and `__Host-` cookie, D-62), a `nonce`
   and an S256 challenge; the provider sends it back to `GET /auth/callback/oidc`, where the library checks the state
   and this server redeems the code itself — client secret in the `Authorization` header (or the body, for a
   provider that takes it only there), the verifier, never redirected, ten seconds, at most 256 KB read. The access
   token is never used, and nothing of the provider's is kept: no token reaches `accounts` (`withoutTokens`). The
   userinfo endpoint is never read — an identity is what a signed token says, not what an unsigned answer does.
2. **What is checked, and where it is decided** (`modules/auth/oidc.ts`, once, for the sign-in and the probe).
   *Discovery* is fetched when a sign-in needs it and never at start or at save — **while no provider is set,
   nothing is sent anywhere** (the self-host path) — from `<issuer>/.well-known/openid-configuration`; the `issuer`
   in it must equal the configured one byte for byte (Discovery §4.3: a mismatch is how a mix-up is made), every
   endpoint must be `https` (`http` only to this machine), and a provider that does not offer the code flow with
   S256, or signs with nothing asymmetric, is refused. *The token*: signature against the provider's keys with an
   algorithm from an allow-list (`RS*`, `PS*`, `ES*`, `EdDSA` — never `none`, never `HS*`, never the token's own say);
   `iss` is the issuer; `aud` contains this client's id and, with several audiences, `azp` is it; `exp`, `iat`, `sub`
   present, thirty seconds of skew, no token older than ten minutes; `nonce` is exactly the one this sign-in made
   (the library refuses a callback with none to bind to). Also the callback's own `iss` parameter (RFC 9207) when the
   provider sends one. *Keys* (JWKS) are cached ten minutes; a token signed by a key not in the cache fetches the set
   again once, and not again for thirty seconds, so rotation works and a stream of forged `kid`s is not a stream of
   requests to the provider. A client-submitted `id_token` on the library's sign-in route is refused
   (`disableIdTokenSignIn`): the only way in is the redirect.
3. **Who an account is, and when an existing one is linked.** An account is `(issuer, sub)` — stored as
   `accounts.account_id = "<issuer>|<sub>"` under `provider_id = "oidc"`: a `sub` is unique only within its issuer, so
   a server later pointed at another provider cannot be signed into somebody's account by a `sub` that repeats.
   **A person whose address differs at the provider from the one on their account is still their account** (the
   subject decides, not the address), and **an account has one identity at the provider**: the library links a
   callback it does not know to the account whose address matches, so a new subject carrying a recycled or
   changed address is refused where the row is made (`identity_conflict`, `failed`), never added beside the old. **An address links to an existing account only if both sides say it is
   verified**: the token must carry `email_verified` of `true` (or the string `"true"`, which some providers send)
   and an address that is one mailbox written one way (D-138 §7), and the existing account's own `email_verified`
   must be true (`requireLocalEmailVerified`, as for GitHub, D-179 §5). Anything else is refused and said:
   `email-unverified` for a provider that does not vouch, `email-taken` for an account whose address was never
   proven — **no account is made, linked or touched**. This is the takeover that is closed: an identity provider
   that lets anybody register an address they do not hold must not be a way into the account of the person who does.
   *What is trusted* is the provider the operator chose, for the addresses it vouches for: an operator who connects
   a provider that verifies addresses loosely has decided that, as one who connects a mail relay has decided who
   reads the links. A multi-tenant issuer whose `iss` varies per tenant is not supported — a fixed issuer is the rule.
4. **Configuration, as GitHub's and the relay's are** (D-179 §6). `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
   `OIDC_CLIENT_SECRET` (all three or none; the secret is sealed in `server_settings.oidc_client_secret_encrypted`
   with its column bound in, like `SMTP_URL`) and `OIDC_NAME` (the button's label, optional) are **a seed**, read on
   the first start only; afterwards Administration → Server is the home. It is **tried before it is kept** — the
   discovery document, the key set, and the token endpoint sent this client's credentials with a code nobody was
   given (`invalid_grant` says the pair is good; `invalid_client` is a refused secret) — under the administrator's
   authority and one rate class with the rest of `/api/server` (`SERVER_ADMIN_BUDGET`). Off while unset: no provider is
   registered, no route answers (`GET /auth/oidc` is `404 ROUTE_NOT_FOUND`) and `AuthMethods.oidc` is `null`.
   **The setup wizard has no step of its own for it**: a first-time server is set up with a way in that proves who the
   first person is (the administrator's password, GitHub or mail), and single sign-on is connected from Administration →
   Server, or by the seed variables on the first start. Disconnecting is refused as the last way in unless the
   administrator says so (`confirmLastChannel`), counting the third way now.
5. **One session, one set of rules.** The session, its cookie (`__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax`, a fixed
   lifetime, hashed at rest, D-11, D-179 §3), the state cookie, the origin rule (D-39), the closed routes and sign-up
   policy (`admittedByPassport`, which an invitation passport satisfies through the same callback) are the library's
   and ours, unchanged: the provider is one more `OAuthProvider` the library is handed, not a path round it. A sign-up
   lost to the same account made at once is sent round once, as GitHub's is (D-78). **The native application's
   handoff works with it with no change** (D-191): the page keeps `{challenge, state}` in the tab across the redirect, as
   it does across GitHub's. Each rate limit that applies to `/auth/*` (the `auth` class, per client) applies to the
   start and the callback.
6. **An account single sign-on is linked to is signed into by it alone, while the provider is connected.** The emailed
   link (D-138) is not sent to an address whose account has an `oidc` account row: asking is answered `202` as for any
   address and nothing is sent, and a link already sent is refused when spent (`fateOf` is asked again). **GitHub is
   not linked to such an account by address either** (`identity_conflict`). Disconnect the provider and both doors
   open again: nobody is shut out by a way in that is gone. A mailbox is not a second door past the
   provider that decides who still works there. *Accepted:* the person has no fallback when the provider is down;
   the server administrator has a password (R30).
7. **Names.** The display name is the token's `name`, cleaned as GitHub's is (controls and direction overrides taken
   out, cut to the column), else the username; the username is made from the address as an email account's is (D-138
   §5). **No picture is taken**: a `picture` is an address of somebody else's that every viewer's browser would be
   sent to. The button's label is plain text of at most 40 visible characters, never markup, and its default is
   worded in the person's language (`Continue with single sign-on`).
8. **The trail.** Connecting, replacing and disconnecting the provider are on the server's audit trail
   (`server.oidc_connected`, `server.oidc_disconnected`), written in the transaction that saves it, never the value. A
   refused sign-in is in the log by the check that refused it (`JWTClaimValidationFailed`, `JWSSignatureVerificationFailed`
   …) and never carries a token or a claim.
9. **Errors reach the person as one reason from the closed set** (D-121): `oidc-unavailable` (the provider did not
   answer, refused the code, or sent a token this server does not believe — the person cannot tell which, and is not
   told), `email-unverified`, and the existing `cancelled`, `expired`, `email-taken`, `signup-closed`, `busy`,
   `failed`; the sentences are in `UX.md` §11 and both languages.

**Rejected.**

- *`discoveryUrl` and the library's generic provider plugin as it ships.* It discovers at start (a network call from a
  server that has been told to send nothing), takes the discovery document's issuer on trust, follows redirects with
  a client secret in the body, has no deadline on its token call, and falls back to the userinfo endpoint when a
  token carries no `id_token`. Each of those is a place a provider's failure becomes ours; the provider here is the
  library's interface, written to the checks above.
- *Linking by address whatever the provider says* — the takeover of §3. *Linking by `sub` alone* — an account with no
  address to anchor it on, which D-38 refuses.
- *An allow-list of email domains (`OIDC_ALLOWED_DOMAINS`).* The provider decides who may sign in to this application
  (that is what an application assignment is); a second list here is a second place for it to go stale. It can be added
  without changing anything above.
- *A step in the setup wizard.* Three screens and a finish rule for a way in an organisation sets up after the first
  person has signed in; the seed variables cover the one-command install.
- *Reading the userinfo endpoint for the address or name.* Unsigned, and one more call that is the provider's to fail.
- *Provider logout (RP-initiated).* Signing out of Purlay ends Purlay's session (D-193); ending the person's session at the
  provider is theirs.
- *SAML.* D-31.

**Accepted.** A provider that does not send `email_verified` — some Microsoft tenants do not — cannot be used until it
does; that is the provider's claim to make, and the setting says why in the sign-in screen's words. A person whose
address is changed at the provider and then matched to another existing account is refused (`email-taken`), not merged.
Deprovisioning at the provider ends nothing here until the session expires (`SESSION_TTL_DAYS`); a server that needs it
sooner signs the person out from the devices list (D-193). The `OIDC_*` seed is ignored after the first start, as
GitHub's is, and named in the log.

**Reverses if** a provider's `id_token` is found to be believed in some case §2 does not name, or the linking rule of §3
turns away the people it should let in more often than it stops the ones it should not: then the rule changes, and
this entry with it. Dropping the way in is `DELETE /api/server/oidc` and a migration that drops four columns.

**Related:** D-251 gives Google a way in of its own, built on the same checks, so that this slot stays for an
organisation's provider.
