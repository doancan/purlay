# D-191. The native application is handed a session of its own by a one-time code bound to a secret it keeps — builds on D-186, D-179

**Amended 2026-11-25.** The session's label names the application by the platform `X-Purlay-Client` says: `ios` is
`Purlay for iOS/<version> (<device>)`, `macos` and any header that is not the shape stay `Purlay for macOS/…`. Only a
platform this server has a name for is read from the header; nothing else of it is copied (D-190).

**Context.** A browser session is a cookie; an application is not a browser, and cannot take one. D-179 gave
identity one owner — GitHub, an emailed link, a password, the setup — and a form of the application's own would be
a second place for it to be decided, with its own throttles and its own mistakes. D-186 left *how the app signs
in* as the one open question.

**Decided.** The person signs in where sign-in already is, in the system browser, and the server then gives the
application a session of its own:

1. The application makes a **verifier** (32 random bytes, base64url), keeps it, and opens
   `<server>/sign-in/native?challenge=…&state=…`, where the challenge is the SHA-256 of the verifier and the
   state is its own word, to be handed back.
2. The page asks the person — naming the account, its address and the server, with *Sign out of this browser, use
   another* beside *Authorize* — and only a click calls **`POST /api/native/authorize`**, which needs a session and
   is refused from any other site by D-80's `Origin` rule. It makes a **code** (32 random bytes, hex, digest stored,
   two minutes) bound to the challenge, and answers `purlay://auth?code=…&state=…`. **The address is the server's
   own and fixed**; the request names none, so there is no open redirect to find. At most five codes are live for a
   person; a sixth makes the oldest room, so a retry never locks anyone out.
3. The application — which has no session yet — calls the public **`POST /api/native/token`** with the code, the
   verifier and a device name. A session is minted for the person who authorised, **a session of its own**, labelled
   `Purlay for macOS/<version> (<device>)`, answered as the usual cookie, which the application keeps and sends as
   an explicit `Cookie` header; it also sends `Origin: <appUrl>` on the socket upgrade, since D-39's check is an
   equality an installed client must meet itself. The session lasts `SESSION_TTL_DAYS` and is never slid
   forward, as every session (`ARCHITECTURE.md` §7.1).
4. **The code is of no use without the verifier**, which never left the application: the code travels in a URL on
   the person's own machine, where a log, a screen share or another application registered for the scheme may read
   it. **One refusal**, `404 NATIVE_CODE_NOT_FOUND`, the same bytes for a code nobody made, one spent, expired or
   burnt, one whose person was erased, and a wrong verifier (the stance of `SIGN_IN_LINK_NOT_FOUND`, D-138). **A wrong
   verifier is counted and committed with its refusal, and does not burn the code until the fifth** — a code
   someone has seen must not be a way to take it from the person it was made for; five guesses at a 256-bit value is
   what a stranger gets. Charged to the client's address before the code is looked at (ten at once, then one every
   ninety seconds; provisional, O-4).
5. **Carried through every way of signing in.** The page keeps `{challenge, state}` in the tab's `sessionStorage`
   across the GitHub round trip and a password sign-in, as D-115 keeps an invitation — the sign-in has no return
   path, and D-115 rejected one as an open redirect. The emailed link may open in another browser, so
   `POST /auth/email` takes an optional `native` pair and the letter carries it in the link's **fragment** beside
   the token, as an invitation the tab holds already is. Then the redirect reaches the application through the
   operating system's registration of `purlay://` and not through the session that was waiting; the application
   accepts it only while an attempt is pending and only with that attempt's `state`.

**Apple platforms (D-338).** The native opening URL may say `platform=macos` or `platform=ios`.
The tab remembers it with the question for display. An emailed link carries this display hint in
its query and preserves the fragment format so older web clients can still read it. Missing or
unknown platform information uses the existing Mac wording. Authorization still uses the same
challenge and state. The platform cannot prove which application opened the page.

**Limits, stated** (found in a review of the change, written here so they are not discovered again):

- A custom scheme cannot prove which application is asking. Any application on the Mac may register `purlay://`;
  the challenge protects the code on its way, not the identity of whoever asked. The consent page therefore names
  what the person can check — the account, the address, the server — and says plainly that it signs the
  application in as that account.
- The sixth authorisation inside two minutes makes the oldest code room without a word: the application holding it
  gets the one refusal and starts again. A retry never locks anyone out; a displaced code is a cause of *does not
  open*.
- The address's budget is shared by whoever shares the address (and, without `TRUST_PROXY`, the whole proxy): ten
  spent by another client leaves the next to wait up to ninety seconds inside a code's two minutes. The
  application treats a `429` as *start again*. The handshake shares the sign-in budget on purpose (D-186): what
  could be spent through it can be spent through `/auth/` already.
- A refusal is written to the log with its reason and nothing else — a wrong verifier and a burnt code as warnings,
  the rest as information — so a guessing campaign is visible, and never the code, its digest, the verifier or the
  person.
- A device name holds none of the invisible characters that change how text reads — zero-width and directional
  marks, embeddings, overrides, isolates, the byte-order mark — so it cannot be made to look like another device.

**Rejected.**

- *A sign-in form of the application's own.* A second UI over D-179's throttles and policies; password managers,
  passkeys and the GitHub flow would each be rebuilt.
- *An embedded web view.* No sign-in shared with the person's browser, and a login page the application draws the
  frame of.
- *A bearer token in the response body.* `API.md` §1 says there is none: one credential kind, which a cookie is.
  The application keeps the cookie's value and sends it back as a header it sets itself — measured with
  `URLSession` on the platform, over HTTP and on the socket upgrade — rather than a second scheme the server would
  have to learn to resolve.
- *A loopback listener* (RFC 8252 §7.3). It needs the entitlement to listen, and a port another process can take.
- *Revoking the session a spent code minted when the code is shown again.* It was in the first design and was
  taken out: with the verifier, nobody but the application can mint a second one, so it catches only an event that
  needs the verifier to have leaked; and it turns a retry that raced its own answer — the same request sent twice —
  into the loss of the sign-in just made, which is the failure it was meant to prevent.
- *A `next` parameter through every sign-in method.* D-115 §8.

**Accepted.** A person signs in again every `SESSION_TTL_DAYS`. The web has no list of devices (*Sessions &
account* has only *Sign out everywhere*), so the application's session is ended there by that button and from the
application itself; the label is in `sessions.user_agent` for an operator. An application that loses the answer to
`token` starts the sign-in again. An emailed link opened in a browser that is not the default one still reaches
the application, but only if the operating system hands the scheme over.

**Reverses if** a scoped, revocable credential for non-browser clients is built (a device list and per-device
tokens): then this is replaced by it, and `native_authorizations` is dropped by a later migration.

*Amended by D-193:* the device list exists, so a session this handoff made is named and ended from any other
device; the credential is still the session.
