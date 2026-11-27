# D-236. Two-step verification for an account with a password: the library's TOTP, no trusted devices, the session never replaced — builds on D-179, D-60, D-85, D-233

**Decided (the owner gave the decision to the maintainer, 2026-10-31).** Only the server's administrator has a
password (D-179 §4), and it is the one account that changes the server; a password leaked from elsewhere was enough to
be them. Better Auth's two-factor plugin (1.7.14) is installed, its table under Purlay's names (`two_factors`, 0067).

- **An authenticator app, and only for a password.** A code from an app (RFC 6238, six digits, thirty seconds, one
  period either side), or one of ten backup codes, each spent once. The card is drawn only for an account with a
  password; GitHub, single sign-on and a link rely on their provider's own second step, and the card says so. Codes
  by mail or message are not offered: a mailbox is what a link already signs in with.
- **Turned on only by a right code.** The password first (counted with the sign-in's wrong guesses, as a change of
  password is, D-179 §4), then the key as a QR code, as text and as an `otpauth://` link, and nothing asks for a code
  at sign-in until one from the app was right (`skipVerificationOnEnable` stays off). The backup codes are shown
  once, with a button that copies them. Turning it off and new backup codes take the password each time. The key is
  never read back: `/two-factor/get-totp-uri` is closed.
- **Sealed.** The key and the backup codes are encrypted by the library under the server's derived auth secret, never
  kept as shown; erasure deletes the row, and nothing exports it. Rotating `ENCRYPTION_KEY` makes every key unreadable,
  as it signs everyone out (`CONFIG.md`): the person turns it on again.
- **No trusted devices.** A session already lasts `SESSION_TTL_DAYS` from sign-in and is never extended (D-60), so
  the code is asked once a sign-in, rarely. A cookie that skips the step for thirty days — refreshed at each sign-in,
  so for good — would be a second long-lived credential that signing out everywhere, a password reset and a
  suspension do not revoke. `trustDevice` is overwritten to false whatever a client sends.
- **The library's lockout, its numbers said.** Five wrong codes spend a challenge (the password again, which is
  throttled); ten in a row across challenges lock the step for fifteen minutes, the right code included; the
  challenge lasts ten minutes. The library also allows three requests to its two-factor routes from one client in ten
  seconds. Locking needs the password, so nobody without it can lock the administrator out.
- **What a right password reveals.** With the second step on, a right password answers "now the code" and a wrong one
  `INVALID_EMAIL_OR_PASSWORD`: the answer says the password was right. That is inherent to asking for the code after
  the password — asking for both at once would make every wrong code a guess at the password too, and the library has
  no such flow. What it gives away is held where it is spent: password guesses are throttled by address and client
  (D-179 §4), and the right password opens nothing without the code.
- **The session is never replaced.** The library replaces the caller's session when the first code turns the step
  on and when it is turned off — useful only to a cookie cache, which is off (D-60). Replaced, the old row's sockets
  would be told it ended, the devices push reaches through it would go with it (D-126) and its lifetime would start
  again. Purlay keeps the old row (its delete hook) and undoes the new one, cookie and all, after the request.
- **A suspended or erased account gets no session through it.** The second step ends in the library's session
  hook, which refuses either (D-233, D-139 §5); erasure also deletes the key and every challenge.
- **The way back in.** `bun run admin:reset-password` — the server's break-glass for the administrator — turns the
  step off with the reset, and says so: lost phone and lost codes are the same lost way in as a lost password.
- **Issuer.** `Purlay (<host of APP_URL>)`, set whatever a client sends, so two servers' keys are told apart in an app.
- **A QR code by a small dependency.** `lean-qr` 2.7.4 (MIT, no dependencies, under 4 kB compressed, released
  2026-09): an encoder written here would be several hundred lines of Reed-Solomon and masking held to the coverage
  floor for one picture. Only its modules are used, drawn as an SVG of the page's own, in the settings chunk, which is
  loaded only when settings open.

**Considered and rejected.** Trusting a device for thirty days (above). Codes by email (a mailbox is already a way
in). A replay cache of spent codes (a code is good for about ninety seconds and only behind the right password, whose
challenge a right code spends). Offering it to accounts without a password (their provider decides their second
step; the library would ask them for a password they do not have).

**Cost of reversing.** Remove the plugin, the card and the code step; drop `two_factors` and
`users.two_factor_enabled` in a new migration — every account then signs in with its password alone.
