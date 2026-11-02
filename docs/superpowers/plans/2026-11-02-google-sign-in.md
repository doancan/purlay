# Google Sign-in Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A separate "Continue with Google" sign-in beside GitHub, configured like GitHub (seed env + Administration → Server), reusing the D-200 OIDC verification core.

**Architecture:** `createOidcProvider` (`apps/api/src/modules/auth/oidc.ts`) is parameterised by a small provider definition (id, accepted issuers, account key, error codes, log prefix, optional admit hook) so the generic OIDC slot keeps its exact behaviour and a second instance — fixed issuer `https://accounts.google.com`, id `google` — is registered with Better Auth by its own plugin. Settings, admin API, contract and web follow the existing GitHub/OIDC patterns one-for-one. Google-specific rules: link by address only for addresses Google is authoritative for; an account Google made gets a "use Google" letter instead of a sign-in link.

**Tech Stack:** Bun, TypeScript, Elysia-style HTTP in `apps/api`, Better Auth, `jose`, Kysely + Postgres, React (`apps/web`), TypeBox contract (`@purlay/types`).

**Spec:** `docs/superpowers/specs/2026-11-02-google-sign-in-design.md` (Turkish; read it first).

## Global Constraints

- Provider id `google`; routes `GET /auth/google` (start) and `GET /auth/callback/google` (callback).
- Issuer `https://accounts.google.com`; the id_token's `iss` may be `https://accounts.google.com` **or** `accounts.google.com` — both accepted for Google only. Generic OIDC keeps exact equality.
- Scopes exactly `openid email profile`. No `picture` taken.
- Account key: `accounts.provider_id = 'google'`, `accounts.account_id = <sub>` (no issuer prefix).
- Seed env `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`: both or neither, else the server refuses to start; read on first start only; secret sealed bound to its column name, redacted in logs.
- Discovery only when somebody presses the button or an admin probes — never at start or save.
- Link by address to an existing account only if: token `email_verified` true, local `users.email_verified` true, **and** the address is authoritative — domain `gmail.com` / `googlemail.com`, or the token carries `hd` and the address's domain equals `hd` (case-insensitive). Otherwise refuse with `email-unverified`, change nothing. No existing account → normal sign-up rules.
- An account Google *made* never gets a sign-in link while Google is connected: it gets a "use Google" letter (en + tr). Email-made accounts keep links. Google disconnected → links again.
- Google is not a way past OIDC: an account with an `oidc` account row is not linked to Google by address (`identity_conflict`). One Google identity per account.
- Audit actions `server.google_connected`, `server.google_disconnected`, written in the saving transaction, never the value.
- No `CONTRACT_VERSION` bump (additions never bump, D-186). New path constants go into `CONSTANTS` in `apps/api/src/contract/bundle.ts`.
- Button order: OIDC (if connected) → GitHub → Google → email. Label "Continue with Google" / "Google ile devam et".
- Multicolour Google "G" as inline SVG in `apps/web/src/components/icon.tsx`; its four colours as brand tokens in `packages/tokens/tokens.json` (same value in every theme; register in `pairs.ts` or `EXEMPT` per D-97). Nothing loaded from Google.
- Decision record D-250; migration `0078`. Commit messages: Conventional Commits, no tool name, no ticket reference, no co-author trailer.
- Two pull requests (production-line budget 400): **PR 1** = Tasks 1–7 (server, contract, docs), **PR 2** = Tasks 8–9 (web). Branches `feat/google-sign-in-server`, `feat/google-sign-in-web`. Each needs an issue (`Closes #n`) labelled with its areas (`api`, `database`, `contracts`, `testing` / `web`, `testing`); use `large-change` only if one still exceeds 400.

## Review Focus

1. **Token `iss` is `accounts.google.com` (no scheme)** — sign-in succeeds; the same token against the generic OIDC slot is refused. Test in Task 2.
2. **Mixed-case address / `hd`** (`Ali@Sirket.COM`, `hd: "sirket.com"`) — counts as authoritative and links. Test in Task 4.
3. **Google sign-in to an account that was email-made and already has a Google row with another `sub`** — refused `identity_conflict`, nothing written. Test in Task 4.
4. **Admin disconnects Google while Google-made accounts exist** — those accounts receive sign-in links again; the last-way-in refusal counts Google. Tests in Tasks 5 and 6.
5. **Seed with only `GOOGLE_CLIENT_ID` set** — server refuses to start with a message naming both variables. Test in Task 3.

---

### Task 1: Schema and contract

**Files:**
- Create: `packages/db/migrations/0078_google_sign_in.sql`
- Modify: `packages/db/src/schema.ts` (server_settings ~479-507; users)
- Modify: `packages/types/src/sign-in.ts`, `packages/types/src/api.ts` (`AuthMethods` ~1598, `MySignIn` ~1750, OIDC request types ~1877), `packages/types/src/setup.ts` (`SealedSettingName` :104, `ServerSettings` channels ~120-131 / 200-218), `apps/api/src/contract/bundle.ts`
- Test: `packages/types/src/contract.test.ts`, `packages/types/src/sign-in.test.ts`, `docs/SCHEMA.md` (check:docs)

**Interfaces — Produces:**
- Columns `server_settings.google_client_id TEXT`, `server_settings.google_client_secret_encrypted TEXT` (CHECK `server_settings_google_pair`: both null or both set; CHECK `server_settings_google_not_blank`); `users.google_made BOOLEAN NOT NULL DEFAULT false`.
- `GOOGLE_START_PATH = '/auth/google'`, `GOOGLE_CALLBACK = \`${AUTH_BASE_PATH}/callback/google\``, `GOOGLE_ISSUER = 'https://accounts.google.com'` (types).
- `SignInFailure` gains `'google-unavailable'`.
- `AuthMethods.google: boolean`; `MySignIn.google: boolean`; `ServerGoogleRequest = { clientId: string; clientSecret: string }` with `GOOGLE_CLIENT_ID_MAX`/`GOOGLE_CLIENT_SECRET_MAX` (same widths as GitHub's); `ServerSettings.channels.google: boolean`; `ServerSettings.googleCallbackUrl: string`; `SealedSettingName` gains `'google'`.

- [ ] **Step 1:** Add failing cases to `contract.test.ts` (an `AuthMethods` without `google` fails `Value.Check`; with `google: true` passes; `ServerGoogleRequest` refuses an empty `clientId`) and to `sign-in.test.ts` (`'google-unavailable'` is in the failure set).
- [ ] **Step 2:** Run `bun --no-env-file --env-file=.env.test test packages/types` — expect FAIL.
- [ ] **Step 3:** Write the migration in the style of `0059_server_settings_oidc.sql` (header comment explaining sealing, pair rule, `google_made` meaning per D-138 §2) and the types above; add the two paths to `CONSTANTS`; add the columns to `docs/SCHEMA.md`.
- [ ] **Step 4:** Run `bun --no-env-file --env-file=.env.test test packages/types && bun run typecheck && bun run check:docs` — PASS (typecheck will flag every `AuthMethods`/`MySignIn` builder; set `google: false` there for now, Tasks 2 and 7 make it real).
- [ ] **Step 5:** Commit `feat(contract): add Google sign-in shapes and the 0078 migration`.

### Task 2: Parameterise the OIDC core; a Google provider

**Files:**
- Modify: `apps/api/src/modules/auth/oidc.ts`
- Create: `apps/api/src/modules/auth/google.ts`
- Test: `apps/api/src/modules/auth/oidc.test.ts` (unchanged, must pass), create `apps/api/src/modules/auth/google.test.ts`
- Test helper: `apps/api/src/testing/oidc-stub.ts` (allow a token `iss` override and an `hd` claim)

**Interfaces — Produces:**
- In `oidc.ts`:
  ```ts
  export interface OidcDefinition {
    readonly id: string;                         // 'oidc' | 'google'
    readonly acceptedIssuers: readonly string[]; // token iss allow-list; discovery issuer must equal credentials.issuer
    readonly accountKey: (issuer: string, subject: string) => string;
    readonly codes: { readonly unavailable: string; readonly unverified: string }; // APIError codes
    readonly logPrefix: string;                  // 'oidc sign-in' | 'google sign-in'
    /** Asked after the token is verified, before the library links or creates; throws APIError to refuse. */
    readonly admit?: (claims: Readonly<Record<string, unknown>>, email: string, accountId: string) => Promise<void>;
  }
  export const OIDC_DEFINITION: OidcDefinition; // id 'oidc', [issuer], accountKeyOf, OIDC_UNAVAILABLE / OIDC_EMAIL_UNVERIFIED, 'oidc sign-in'
  export const createOidcProvider(credentials, name, deps, definition?: OidcDefinition): OidcProvider // default OIDC_DEFINITION
  ```
  `OidcProvider.id` becomes `string`. Generic OIDC output is byte-identical (same codes, logs, account key).
- In `google.ts`:
  ```ts
  export const GOOGLE_PROVIDER_ID = 'google';
  export const googleDefinition = (issuer: string, admit: OidcDefinition['admit']): OidcDefinition;
    // acceptedIssuers: [issuer, issuer without 'https://'], accountKey: (_, sub) => sub,
    // codes GOOGLE_UNAVAILABLE / GOOGLE_EMAIL_UNVERIFIED, logPrefix 'google sign-in'
  export const authoritativeForGoogle = (email: string, hd: unknown): boolean;
  ```
  The issuer is a parameter (default `GOOGLE_ISSUER` at the call site) so tests point it at the stub.

- [ ] **Step 1:** Write `google.test.ts`:
  - `authoritativeForGoogle('a@gmail.com', undefined)` → true; `'a@googlemail.com'` → true; `'Ali@Sirket.COM', 'sirket.com'` → true; `'a@sirket.com', undefined` → false; `'a@sirket.com', 'other.com'` → false; `'a@sub.sirket.com', 'sirket.com'` → false; `hd` non-string → false.
  - With the stub: a token whose `iss` is the stub issuer without scheme is accepted by the Google definition and refused by `OIDC_DEFINITION`; account key is the bare `sub`; refusal codes are `GOOGLE_*`.
- [ ] **Step 2:** Run `bun --no-env-file --env-file=.env.test test apps/api/src/modules/auth/google.test.ts` — FAIL.
- [ ] **Step 3:** Implement. `jwtVerify` gets `issuer: [...definition.acceptedIssuers]`; `userInfo` calls `definition.admit` after the address check and before `onIdentity`; every hard-coded `OIDC_PROVIDER_ID`, code and log prefix reads from the definition.
- [ ] **Step 4:** Run `google.test.ts` and `oidc.test.ts` — PASS; `bun run typecheck` clean.
- [ ] **Step 5:** Commit `refactor(auth): let the OIDC core serve a second, fixed provider` then `feat(auth): add the Google provider definition` (two commits; the first must leave all OIDC tests green on its own).

### Task 3: Configuration and settings

**Files:**
- Modify: `apps/api/src/platform/config.ts` (schema ~88-96, redaction ~216, problems ~502), `apps/api/src/modules/setup/settings.ts` (`SettingsPatch` ~86, `SettingsSeed` ~105, `SEALED_IN` ~117, read ~233, `columnsOf` ~419, view ~551, `envSeedOf` ~610, `ignoredEnvironment` ~665), `.env.example`, `docker-compose.production.yml` (~68), `docs/CONFIG.md`
- Test: `apps/api/src/platform/config.test.ts`, `apps/api/src/modules/setup/settings.integration.test.ts`

**Interfaces — Produces:** `SettingsPatch.google?: { clientId: string; clientSecret: string } | null`; `SettingsSeed.google`; the read settings carry `google: { clientId; clientSecret } | undefined` (unsealed), the view carries `google: boolean`.

- [ ] **Step 1:** Tests: only `GOOGLE_CLIENT_ID` set → config problem naming both variables; both set → seed imported once into the sealed column (`google_client_secret_encrypted` ≠ the secret, opens only for its column); second start ignores the env; secret never appears in the redacted config dump; patch `google: null` clears both columns.
- [ ] **Step 2:** Run both files — FAIL.
- [ ] **Step 3:** Implement following GitHub's pair exactly; document both variables in `CONFIG.md` (table rows after `OIDC_NAME`, and the "where it lives afterwards" list), `.env.example`, compose.
- [ ] **Step 4:** Run both files and `bun run config:example -- --check` — PASS.
- [ ] **Step 5:** Commit `feat(setup): keep Google's client in the server settings`.

### Task 4: Register Google with the sign-in library; linking rules

**Files:**
- Modify: `apps/api/src/modules/auth/better-auth.ts` (`AuthSettings` ~101, `SignInRound` ~244, plugin ~405, `refusedIdentityConflict` ~826, provider build ~1343, plugins ~1636, user create hook ~1675, `lostSignUpRace` ~1825, `signInLinks` / returned methods ~1053/1116/1864/1910), `apps/api/src/modules/setup/runtime.ts` (~99, ~395), `apps/api/src/ingress/http/auth.ts` (`SignInProvider` :87, `notSetUp`/`connected`/`providerOfCallback` ~90-104, failure maps ~231-275), `apps/api/src/ingress/http/app.ts` (start route ~750, error hook ~672), `apps/api/src/ingress/http/auth-methods.ts`, `apps/api/src/modules/auth/my-sign-in.ts`
- Create: `apps/api/src/testing/google-sign-in.ts` (mirrors `oidc-sign-in.ts`: `aGoogleAuth`, `signInWithGoogle`)
- Test: create `apps/api/src/ingress/http/google-sign-in.integration.test.ts`; update `auth-methods.test.ts`, `client-handshake.test.ts`, `my-sign-in.integration.test.ts`

**Interfaces:**
- Consumes: Task 2 `googleDefinition`, `authoritativeForGoogle`, `GOOGLE_PROVIDER_ID`; Task 3 settings `google`.
- Produces: `AuthSettings.google: { clientId; clientSecret } | undefined`; `createAuth` deps gain `googleIssuer?: string` (default `GOOGLE_ISSUER`); `SignInRound.googleAccountId?: string`; returned `google: boolean`; `SignInLinks.google: boolean` (connected now); `AuthMethods.google` and `MySignIn.google` real.

- [ ] **Step 1:** Integration tests (stub as Google):
  - unset → `GET /auth/google` is `404 ROUTE_NOT_FOUND`, `AuthMethods.google === false`.
  - new person, `signUp: 'open'` → account made, `users.google_made = true`, `accounts` row `('google', sub)`, session set; no `picture` stored.
  - invite-only without passport → `signup-closed`; with an invitation passport → made.
  - existing email-made verified account `ali@gmail.com` → linked (same user id), `google_made` stays false.
  - existing verified `ali@sirket.com`, token without `hd` → `email-unverified`, no `accounts` row, user untouched; with `hd: 'sirket.com'` → linked; `Ali@Sirket.COM` + `hd: 'sirket.com'` → linked.
  - token `email_verified: false` → `email-unverified`; local account unverified → `email-taken`.
  - account with an `oidc` row → `identity_conflict` (`failed`); account with a Google row of another `sub` → `identity_conflict`.
  - token `iss: 'accounts.google.com'` form → signed in.
  - a linked person whose Google address changed signs in → same account (the `sub` decides), `users.email` unchanged.
  - provider unreachable → `google-unavailable`.
  - two concurrent first sign-ins of the same `sub` → one account (lost race re-sent once, as GitHub's).
  - `my-sign-in`: `google: true` for a linked account.
- [ ] **Step 2:** Run the new file — FAIL.
- [ ] **Step 3:** Implement:
  - Build the Google provider when `settings.google` is set, with `admit` = query `users` by email; if a user exists, has no `accounts` row `('google', accountId)`, and `!authoritativeForGoogle(email, claims.hd)` → throw `APIError('FORBIDDEN', { code: 'GOOGLE_EMAIL_UNVERIFIED' })`.
  - Plugin `purlay-google` registering it (same shape as `oidcRegistration`).
  - `onIdentity` sets `round.googleAccountId`; the user create hook sets `googleMade: true` (add `googleMade` → `google_made` to `additionalFields`, overwritten from the round like `githubId`) and `round.made = true`.
  - `refusedIdentityConflict`: for `providerId === 'google'` refuse if the user holds an `oidc` row or a `google` row with another `account_id`; GitHub linking unchanged.
  - `lostSignUpRace` keys on whichever of profile / oidc / google the round holds.
  - HTTP: `SignInProvider = 'github' | 'oidc' | 'google'`; `/auth/google` start; error hook covers `GOOGLE_CALLBACK`; map 502 → `google-unavailable`, 403 → `email-unverified` for the Google callback.
- [ ] **Step 4:** Run the new file, `oidc-sign-in.integration.test.ts`, `better-auth.integration.test.ts`, `auth-methods.test.ts`, `client-handshake.test.ts`, `my-sign-in.integration.test.ts`, `invitation-passport.integration.test.ts` — PASS.
- [ ] **Step 5:** Commit `feat(auth): sign in with Google`.

### Task 5: Email links for accounts Google made

**Files:**
- Modify: `apps/api/src/modules/auth/magic-link.ts` (`madeByGitHub` :72, `Fate` :78, `fateOf` :84, send ~204), `apps/api/src/modules/auth/sign-in-letters.ts`, `apps/api/src/modules/auth/my-sign-in.ts` (`emailLinks`)
- Test: `apps/api/src/modules/auth/magic-link.integration.test.ts`, `sign-in-letters.test.ts`, `my-sign-in.integration.test.ts`

**Interfaces — Produces:** `Fate = 'link' | 'github' | 'google' | 'nothing'`; `fateOf(executor, clock, email, signUp, ssoConnected, googleConnected: boolean)`; `madeByGoogle(account: { google_made: boolean }): boolean`; `googleLetter(to, locale, appUrl): MailMessage`.

- [ ] **Step 1:** Tests: Google-made account asks for a link → no link, one `googleLetter` (en and tr wording asserted: subject + body name "Continue with Google" / "Google ile devam et"); same account with Google disconnected → a link; email-made account later linked to Google → a link; a link issued before the account became Google-made is refused when spent; `my-sign-in.emailLinks` false for a Google-made account while connected.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement; order in `fateOf`: OIDC rule, then GitHub-made → `'github'`, then Google-made and `googleConnected` → `'google'`, else `'link'`. Wire `googleConnected` from `SignInLinks.google`.
- [ ] **Step 4:** Run — PASS.
- [ ] **Step 5:** Commit `feat(auth): tell an account Google made to use Google`.

### Task 6: Administration API

**Files:**
- Modify: `apps/api/src/modules/setup/probes.ts` (`probeOidc` ~303-388 → shared core + `probeGoogle`), `apps/api/src/modules/setup/server-admin.ts` (`connectOidc` ~246 pattern, `disconnect` ~317-358, `DISCONNECTED` ~125, `hasProvider` ~373/392, `serverSettingsOf` ~192), `apps/api/src/ingress/http/server.ts`, `apps/api/src/ingress/http/app.ts` (~861-887), `apps/api/src/modules/audit/server-audit.ts`
- Test: `apps/api/src/ingress/http/server.integration.test.ts`, `apps/api/src/modules/setup/probes.integration.test.ts`

**Interfaces — Produces:** `POST /api/server/google` body `ServerGoogleRequest` → `ServerSettings`; `DELETE /api/server/google` body `ServerDisconnectRequest`; probe reasons reuse the OIDC set (`unreachable`, `secret-rejected`, `client-unknown`, …); disconnect channel union gains `'google'`.

- [ ] **Step 1:** Tests: non-admin `403`; good pair (stub answers `invalid_grant`) → saved, `channels.google: true`, audit row `server.google_connected` without the secret; `invalid_client` → `secret-rejected`, nothing saved, no audit; disconnect → cleared, `server.google_disconnected`; Google as the only way in → disconnect refused `last-channel` unless `confirmLastChannel`; with Google the only provider, turning passwords off is allowed (`hasProvider`); `googleCallbackUrl === APP_URL + GOOGLE_CALLBACK`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement following the OIDC handlers; the probe for Google uses `googleIssuer` (test seam) and the Google definition.
- [ ] **Step 4:** Run both files — PASS.
- [ ] **Step 5:** Commit `feat(server): connect and disconnect Google from Administration`.

### Task 7: Decision record, docs, mutants — then open PR 1

**Files:**
- Modify: `docs/DECISIONS.md` (append D-250; one "Related: D-250" line under D-200), `README.md` (decision count), `docs/API.md` (the `/auth/google`, callback, `/api/server/google` rows; `AuthMethods`), `docs/CONFIG.md` (operator note: Google Cloud Console → OAuth client "Web application", redirect `APP_URL/auth/callback/google`, consent screen External, publish to "In production"), `docs/changelog/changes.md` (**Added**: `- **Sign-in** — Sign in with Google, beside GitHub, once an administrator connects it (D-250)`), `scripts/mutations.ts`
- Test: `bun run check:docs`, `scripts/changelog.test.ts`

- [ ] **Step 1:** Add mutants (each with `tests:` naming the file that kills it): `google-authoritative-ignored` (`authoritativeForGoogle` → `true`; killed by `google-sign-in.integration.test.ts`), `google-identity-conflict-skipped` (the `google` branch of `refusedIdentityConflict` removed; same file), `google-made-gets-links` (the `'google'` branch of `fateOf` removed; `magic-link.integration.test.ts`). Verify each by hand: apply, run its test, see a failure, restore.
- [ ] **Step 2:** Write D-250 (Context, Decision 1–n matching the Global Constraints, Rejected: the generic slot for Google; `hd` as an entry restriction; trusting every verified address; links for Google-made accounts; several OIDC slots; a monochrome mark; a setup-wizard step; Cost of reversing).
- [ ] **Step 3:** Run `bun run check:docs`, `bun run typecheck`, `bun run lint`, `bun run knip`, `bun run format:check`, `bun run test`, `bun run test:integration` — all clean (needs Docker + `POSTGRES_PORT=55432 bun run db:up:postgres`).
- [ ] **Step 4:** Commit `docs: record Google sign-in (D-250)`; create the issue, push `feat/google-sign-in-server`, open PR 1 with the repository template filled (Failure modes: each line names its test).

### Task 8: Web — the Google button

**Files:**
- Modify: `packages/tokens/tokens.json` (+ `pairs.ts`/`EXEMPT`), `apps/web/src/components/icon.tsx` (glyph `google`, multicolour, `aria-hidden`), `apps/web/src/features/sign-in/sign-in-screen.tsx` (~132-151, `sentenceFor` ~58), `apps/web/src/features/sign-in/sign-up-screen.tsx`, `apps/web/src/features/invitations/invite-screen.tsx` (~241-272), `apps/web/src/i18n/catalogue/en.ts` + `tr.ts`, `apps/web/src/testing/fake-api.ts`, `apps/web/e2e/sign-in.e2e.ts` (methods JSON), `docs/UX.md` §11
- Create: `apps/web/src/features/sign-in/google-button.tsx` (via `provider-button.tsx`, `href` `GOOGLE_START_PATH`, icon `google`)
- Test: `sign-in-screen.test.tsx`, `sign-up-screen.test.tsx`, `invite-screen.test.tsx`, `apps/web/src/components/icon.test.tsx`

**Interfaces — Consumes:** `AuthMethods.google`, `GOOGLE_START_PATH`, `'google-unavailable'` (Task 1).

- [ ] **Step 1:** Tests: with `{ github: true, google: true, oidc: {name: null} }` the links are, in order, `['/auth/oidc', '/auth/github', '/auth/google']`; Google alone shows only Google (and not the "not set up" panel); label `Continue with Google` / tr `Google ile devam et`; `?error=google-unavailable` shows its sentence in both languages; invite screen's Google button asks for the passport first (`before`); the `google` glyph renders with no stroke class expectation broken (adjust `icon.test.tsx` for a filled multicolour glyph); axe has no violations on the sign-in screen.
- [ ] **Step 2:** Run `bun --no-env-file --env-file=.env.test test apps/web/src/features/sign-in apps/web/src/features/invitations apps/web/src/components` — FAIL.
- [ ] **Step 3:** Implement. Sentence for `google-unavailable`: en "Google did not answer. Try again in a moment, or sign in another way." / tr "Google yanıt vermedi. Biraz sonra yeniden dene ya da başka bir yolla gir." Add it to `UX.md` §11.
- [ ] **Step 4:** Run the files above, `bun run lint`, `bun run tokens:check`, `bun run budget:web` — PASS.
- [ ] **Step 5:** Commit `feat(web): continue with Google on the sign-in, sign-up and invitation screens`.

### Task 9: Web — Administration card and account row — then open PR 2

**Files:**
- Create: `apps/web/src/features/settings/pages/server-google.tsx` (pattern: `server-oidc.tsx`, fields client id + secret, copyable `googleCallbackUrl`, connect / replace / disconnect, reasons `setup.google.reason.*`)
- Modify: `apps/web/src/features/settings/pages/server.tsx` (:56-57), `server-parts.tsx` (disconnect channel :87, lists :103/:112), `server-client.ts` (probe :34/:95, channel :44, guards :70-78), `server-policies.tsx` (:116 `providers` includes Google), `account.tsx` (:84-92 "Google linked" row), `apps/web/src/features/setup/errors.ts`, i18n `en.ts`/`tr.ts`, `apps/web/src/data/api.ts` (+ test)
- Test: `apps/web/src/features/settings/pages/server.test.tsx`, `server-client.test.ts`, `account.test.tsx`, `apps/web/src/data/api.test.ts`; `apps/web/e2e/server-settings.e2e.ts` if it enumerates cards

- [ ] **Step 1:** Tests: the card shows the callback URL and copies it; submitting calls `POST /api/server/google` with both fields and shows "Connected"; `secret-rejected` shows its reason in both languages; disconnect as the last way in asks for confirmation; the policies page counts Google as a provider; the account page shows "Google: linked" when `MySignIn.google`.
- [ ] **Step 2:** Run — FAIL.
- [ ] **Step 3:** Implement following `server-oidc.tsx`.
- [ ] **Step 4:** Run the web tests, `bun run lint`, `bun run typecheck`, `bun run test` — PASS; run the affected e2e files if Playwright is available locally, else rely on CI.
- [ ] **Step 5:** Commit `feat(web): connect Google from Administration and show it on the account page`; create the issue, push `feat/google-sign-in-web` (based on PR 1's branch until it merges), open PR 2.
