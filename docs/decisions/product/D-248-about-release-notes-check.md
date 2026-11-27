# D-248. About, the newest release and the release notes: a server-side check, a per-browser window — builds on D-39, D-185, D-186, D-196

**Context.** A person using a self-hosted server could not tell which version it ran, whether a newer one existed, or
what an update had changed. The version was already public (`GET /api/client`, D-186, for native clients) and each release already had its
notes (`docs/changelog/v{x.y.z}.md`, D-185); neither reached a screen.

**Decision.**

1. **Settings → About**, in the account group, for everyone (`UX.md` §2): the version the server runs, the newest
   release on GitHub, one sentence that compares them, the notes of the running version, the licence and the repository.
2. **The server asks GitHub, never the browser.** The page's policy allows only its own origin (D-39), so a browser
   cannot ask, and should not be made able to: the address of every person who opened About would reach GitHub.
   `GET /api/releases/latest` (`API.md` §2; any signed-in person) answers `{ current, latest: { version, url, publishedAt } | null }`,
   `latest: null` meaning *could not check*, and `current` the version this server runs — always, also with the check off.
   **The version comes from this route, not from `GET /api/client`.** The public route is charged to the client's
   address with the sign-in traffic (D-186), and the web app asked it on every load of the signed-in frame and on About: a
   shared address — an office, a proxy — spent the budget people sign in with, and the browser tests saw `429`. This route
   needs a session and is charged per person, to the costly reads. `GET /api/client` stays for the native applications,
   which ask it once before anybody has signed in, and no code of the browser's names it (a test holds that). The server makes one anonymous `GET {GITHUB_API_URL}/repos/purlay/purlay/releases/latest`
   (`features/chat/integrations/latest-release.ts`), bounded as every call to GitHub is — a deadline, no redirect followed, the body
   checked against a schema, never throwing to the caller — and accepts only a tag of three numbers behind a `v` and a page on
   `https://github.com/`; a draft, a pre-release, a rate limit, a `5xx`, a redirect or anything else is `null` and one log line
   without the body. The page must be exactly this repository's page of that tag
   (`https://github.com/purlay/purlay/releases/tag/<tag>`), so a link is built, not believed. A good answer is kept six
   hours, in memory, and callers arriving together share one call. **A failure does not take back what was learned:** when
   the six hours lapse and GitHub does not answer, the last good answer is served on and GitHub is asked again after a
   failure window of ten minutes — or, for a limit that names its wait, that wait, at most an hour. Only a server that has
   never had a good answer says `null`. The body GitHub sends is read whole, bounded by nothing but what GitHub sends: a
   cap would sit in the reader every call to GitHub shares, and a release body is a few kilobytes on a path that only
   GitHub's own API reaches, over a deadline of ten seconds. Where it lives is the cache's: the cloud's several nodes each ask at most once in the window, which is a few calls
   a day and needs no shared store (D-7).
3. **An operator's switch, and what is sent.** `UPDATE_CHECK` (`CONFIG.md`, default on). Off, the server never calls GitHub for
   it and the answer is `null`; About then says it could not check. The call goes only to GitHub's API, carries no cookie,
   token, address, name, version or identifier of this instance, and so tells GitHub what any visitor to the public
   repository's releases would: that some server asked. The path is not under `/api/server/`, which is Administration →
   Server's, charged by client address before a session is looked at and an administrator's alone; this is a read for
   everyone and is charged to the costly reads, per person, since it is a call the server may make on a reader's behalf.
4. **The notes window is remembered per browser, in `localStorage`.** The first screen of the signed-in frame opens the
   notes of the version the server runs when `purlay.releaseNotesSeen` is not that version, and closing it by any means
   stores it. The key is the device's, not the person's: signing out does not forget it. Storage that cannot be read shows
   nothing, not the window at every load.
5. **The notes are in the build, one lazy chunk per release.** The client bundles `docs/changelog/v*.md` as raw text
   (`import.meta.glob`, lazy), so none counts against the first load (D-196) and one is fetched only when the window is
   to open; the image's client stage copies `docs/changelog` for it (`Dockerfile`, held by `scripts/dockerfile.test.ts`).
   The lines are drawn by the renderer messages use, so a bold area and a name in code are what they were written as.
   The shape of the notes — the categories and the heading — is read by `readReleaseNotes` in `@purlay/types`; the release
   command judges the files with a list of its own (the scripts depend on no package, so a release can be cut from a bare
   checkout), and `scripts/changelog.test.ts` holds the two to each other.

**In the browser,** About and the window read both from one request; a failed request (a refusal, a lapsed session, no
network) is an error with **Retry** in the card, told apart from the deliberate *could not check*, and is not retried on
its own. While the version is unknown, or if it could not be read, no window opens. Notes whose
chunk fails to load (after a redeploy, say) are neither shown nor remembered as *none*: the failure is noted on the page and
the next screen that asks tries again.

**Consequences.** A server with no way out, or whose operator turned the check off, shows *could not check* — a
sentence, not an error. A server whose GitHub is an Enterprise Server shows it too: the page of a release must begin with
`https://github.com/`. Another browser, or a person who cleared their data, sees the window once more. A release without
its notes file shows no window. The notes are in English, as written.

**Rejected.** *The browser asking GitHub* — blocked by D-39's policy, and loosening it for a cosmetic line would put a
third party in every page's allowed list. *Fetching the notes from the release's body on GitHub* — it needs the network
and a server that can reach GitHub to show what the running version did, and the body is the notes of the newest release,
not of the one that runs; the files in the build work offline and are exactly the running version's. *A table for what a person has seen*
— a migration and a row per person for a message that is cosmetic and once per version; the cost accepted is that another
browser shows it once more. *Storing the dismissal only when storage works and showing the window otherwise* — a window that
cannot be dismissed for good is worse than one that is missed. *`/api/server/release`* — see 3. *A setting in the database
rather than a variable* — an operator who forbids outbound calls decides it before the server starts, and a variable is
where every other outbound call is decided. *A shared cache for the nodes of the cloud* — D-7: a few calls a day per node
are not a measurement that justifies one.

**Cost of reversing.** Remove the route, the variable, the page, the window and the `COPY` line; delete
`purlay.releaseNotesSeen` from nobody's browser — it is a leftover key a person can ignore. Nothing is stored on the server.
