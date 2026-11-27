# D-356. Erasure reads when the person signed in, and a native application can ask for a fresh sign-in — amends D-139, D-191

**Decided (the owner, 2026-11-27).** Erasure asks for a session signed in within `ERASURE_SIGN_IN_MINUTES` (D-139 §5) and read
that as the session's `created_at`. The native handoff (D-191) issues its session when the application
spends the code, so a browser signed in weeks ago handed the application a session that looked freshly
signed in, after one click on *Open Purlay*. The web asks for more than that. The handoff already copies
the browser session's `session_authentication_evidence` (the observed sign-in, D-310). Workspace security
reads freshness from there, never from issuance. Erasure did not. The application also had no way to ask
for the credential to be checked now, which is what it needs before it offers erasure.

**What changed.**

1. **Erasure reads the sign-in, not only the issuance.** A session is recent enough when it was issued
   within the window and, where it records a primary authentication, that authentication is within the
   window too. A recorded row with no time (*unknown*, a session from before the evidence existed) is never
   recent. A session with no row at all is judged by its issuance as before, which only a browser session
   from before D-310 can be, and such a session is older than the window.
2. **A handoff never hands over "no evidence".** After copying the source's evidence, the exchange writes
   an unknown row if none was copied, so a session the handoff minted is never judged by its issuance.
   Workspace access already treats an unknown row as it treats a missing one.
3. **`prompt=login`.** The application may open `/sign-in/native?challenge=…&state=…&prompt=login`. The tab
   keeps it with the question, and the page sends `prompt: 'login'` to `POST /api/native/authorize`. The
   server then makes a code only for a browser session whose primary authentication is within
   `NATIVE_FRESH_SIGN_IN_MINUTES` (five). Anything else, unknown included, is
   `403 REAUTHENTICATION_REQUIRED`, and no code is made. The page says *Sign in again to continue* and signs
   the browser out with the question kept, and the person signs in through the ordinary sign-in: the
   password, the provider's round trip or the emailed link, and the second step where it is on. The code then
   carries that fresh evidence to the application's session, which has most of `ERASURE_SIGN_IN_MINUTES`
   left. The decision is the server's; the page only carries the word. An emailed link does not carry the
   prompt, because whoever follows one has just signed in.
4. **Discoverable, additive.** `ClientInfo.capabilities.nativeFreshSignIn: true` tells an application that
   this server honours the prompt. An older server ignores the unknown query parameter, and its erasure is
   then refused for a stale handoff, so the application asks the person to sign in again in the browser.
   A field and a constant were added and none were changed: no `CONTRACT_VERSION` bump (D-58).

**Rejected.**

- *`max_age=<seconds>` chosen by the application.* It is a second knob for the same question. The window the
  application needs is the server's (erasure's), so the server owns it. It can be added later as an
  addition if a caller with another window appears.
- *Forcing the credential on every native sign-in.* That would undo the one-click handoff D-191 chose, for the
  many sign-ins that do not need it.
- *Re-authenticating inside the consent page without signing the browser out.* It would be a second
  credential form beside the sign-in (D-191 rejected a sign-in form of the application's own for the same
  reason). Signing out and in again reuses every method, throttle and second step there is.
- *Refusing erasure from every native session.* An application that cannot erase its own account offers
  less than the web does. This way the person proves who they are, as on the web.

**Accepted.** A person asked for a fresh sign-in loses the browser session they had. They sign back in
straight away, and the new session replaces it. Clock skew between nodes is read as the session's issuance
always was: a time a little ahead is accepted, since only the server writes it.

**Cost of reversing.** Dropping the prompt is removing an optional field that only newer applications send.
Reading issuance alone again would reopen the hole this closes.
