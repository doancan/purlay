# D-246. GitHub issues from conversations: one GitHub App, three kinds of token — builds on D-11, D-23, D-134, D-179, D-39 §6; closes #874

**Context.** `PRD.md` §4 Phase 2 proposed creating and following GitHub issues from a thread and asked for the
distinction from D-11 to be recorded before any code. D-11 and D-23 say what is true of sign-in and of the
workspace's credential: a card is drawn with **one credential per workspace, never a member's**, since whether it
renders would tell who can see a private repository. Writing an issue *as a person* needs the opposite — their
own access — and neither is sign-in.

**Decision.** *Built in the PRD's order; this entry is the whole design, and the pull request that builds each
step says which.*

1. **One GitHub App, three kinds of token, each for one thing and never for another's.**
   - **Sign-in** stays the OAuth app (`read:user user:email`, D-38, D-179), untouched and never asked for more.
   - **The installation's token** — minted from the App's private key — reads everything shared: link state,
     what a thread shows of an issue, webhooks. It survives any person leaving, and is never a person's.
   - **A person's own App user access token** exists only for **that person's writes** (creating an issue). It
     expires (eight hours), has a sealed refresh token, and reaches only what both the person and the App can.
   Shared previews and cards keep the rule of D-23: nothing a person's token reached is ever shown to the
   channel. D-11's *identity* is not amended — sign-in is not a GitHub authorization to write — and D-23's
   *workspace credential* is not replaced: the workspace token and the feeds keep working as they were.
2. **Least privilege on the App**: Issues **write**, Pull requests **read**, Metadata **read**, Contents **none**,
   no organisation-wide permission. Labels and assignees are out: they would need more, and nobody asked.
3. **The App is a setting of the server's** (D-179 §6): its id, slug and client id in the clear; its client
   secret, its private key and its webhook secret sealed by the one cipher (D-39 §6), each bound to its
   column, all six or none (`0075`). Seeded once from `GITHUB_APP_*`, then changed in Administration → Server,
   where it is **tried before it is kept** — the client pair at GitHub's token endpoint, then a JSON Web Token
   its key signs (`GET /app`) — and kept only if both held and the App is the one named. It is not a way in:
   disconnecting it needs no confirmation.
4. **The capability is the App.** Without one, the feature is invisible and nothing changes: no card, no
   route (`404 ROUTE_NOT_FOUND`), no address for deliveries, and `GET …/github-app` says `available: false`.
   Disconnecting it later stops every write and leaves what exists — links, the workspace token, feeds.
5. **An owner connects the installation** and chooses its repositories on GitHub's own screen. The trip's
   `state` is a random token of which only the digest is kept, for ten minutes, spent as it is read. GitHub's
   callback names an installation in its query, which anybody can write, so it is believed only when the
   `code` GitHub sent with it (the App asks for authorization during installation), redeemed, belongs to a
   person who GitHub says can reach that installation, who is the browser that left, and who is still the
   workspace's owner. The code's token is then **dropped**, not kept: connecting is not the person's consent
   to write as them.
6. **A person's own authorization is a separate, explicit opt-in** — "Let Purlay create issues as me" on
   Sessions & account, off until chosen, never asked at sign-in. PKCE `S256`, the verifier sealed in the
   handshake; the access and refresh tokens sealed to their row and column. The person forgets it at any
   time, and GitHub's `github_app_authorization` revocation forgets it too.
7. **Revocation is believed from three places** — the person, GitHub's delivery to the App's one address, and
   a `401` from GitHub — and **closes writes, keeps links**. An installation removed on GitHub is let go in
   every workspace that connected it (GitHub's id is not unique to a workspace); a suspension is kept and
   said, and used for nothing. Deliveries are signed by the App's webhook secret, applied once by id and by
   body digest (D-231 §1), and swept after thirty days.
8. **An issue is made from a thread by a review, and the write is recoverable before it is enabled** (the PRD's
   second and fourth steps, built together). The thread offers a repository — only one GitHub lists for the person's
   own token inside the installation, so one both they and the App reach — an editable title and body that start as
   the question, its accepted answer, the decision note and a link back, and a review of the destination and the
   exact text, marker line included, before **Create**. The words of a conversation that is not public are copied
   only when the person ticks that they choose it. Title and body only. Channel membership, the installation, the
   authorization and the repository are all checked again as it is sent. The issue is linked to the root
   (`github_links`, shown in the thread and told by `THREAD_UPDATED`), and **does not resolve the question** nor
   notify anybody.
   - **One request, one issue.** The client's request id, with the workspace and the person, keys a bounded record
     (`github_operations`, thirty days) claimed *before* GitHub is asked: a double click, a retry and a second tab
     are one operation, and only the request that claimed it posts. The id with other content (a digest of it, never
     the words) is `409 GITHUB_REQUEST_CONFLICT`.
   - **A lost answer is found, never repeated.** GitHub not answering — a timeout, a `5xx`, a reply that is not an
     answer — leaves the operation `unknown`. The same request sent again reads GitHub as the installation (which
     survives the person) for the issue that ends in the marker, `<!-- purlay:<request id> -->`, which the review
     showed. Not seen after fifteen minutes, or twenty looks, it is `refused` as `not-created` and may be started
     again with a new id; a claimed operation never answered is taken as unknown after two minutes. It is never
     posted a second time on a guess.
   - **A limit is the client's to wait out.** GitHub's `Retry-After` (or its reset) comes back as `429` with the
     same header and the claim is given back, so the same request goes through afterwards; nothing here sleeps or
     retries on its own, so retries are bounded by the person and the twenty looks.
   - **The person's token** is refreshed under its row's lock when it is within a minute of lapsing — a refresh token
     is spent by the refresh that uses it — and forgotten when GitHub stops taking it (`409
     GITHUB_AUTHORIZATION_REQUIRED`, asked for again in the dialog).
   - **Audited by identifier**: who, which repository, which issue and channel — never a title or a body
     (`integration.issue_created`). Links and operations are classified for the workspace's export (links
     exported, operations not) and are not in a person's own.
9. **Linked work is followed, quietly** (the PRD's third step). A member of the channel may also point a root at an
   issue or pull request that exists, by its address. It is read with the **installation's** token — what a thread
   shows is the workspace's, the same for everybody, and survives the person — while the person's own access still
   decides whether they may point at it: the repository must be one GitHub lists for them inside the installation, and
   one answer says it does not exist or may not be reached, so a private repository's titles cannot be had by
   naming it. A thread holds at most twenty. The App's `issues` and `pull_request` events then keep each link's title
   and state — open, closed, merged — current:
   - **Deliveries are the feeds' kind** (D-134 §5, D-231 §1): signed by the App's secret, applied once by id and by
     body digest, bounded and read within a deadline.
   - **Out of order, and again, is nothing.** A link keeps GitHub's own `updated_at` for the item (`state_at`); an
     older event is dropped, and one that says what the link already says only moves that instant — so repeated state
     updates **coalesce** into the one a person sees, and the next older word is still judged by the newest.
   - **Only the installation's workspaces.** A delivery changes the links of the workspaces that connected the
     installation it came through, whatever repository it names.
   - **Shown, never told.** A change is drawn on the root and sent to those with its thread open (`THREAD_UPDATED`); it
     is no message and no unread, and notifies nobody, so the notification levels and Deep Work (D-12, D-15) hold by there
     being nothing to hold. **Resolving the question stays a person's act** (D-204).
   - **An issue seen being opened with the marker of an operation still waiting on GitHub's answer completes it**
     (§8), so a lost answer is found by the webhook as well as by the reads.
   - **A link outlives the installation**: removed on GitHub, the work stays on the thread, followed no more.

**Rejected.** *Asking for the person's authorization at sign-in* — a sign-in that can write to repositories
is a bigger grant than anybody agreed to, and most people never create an issue. *One person's token for
shared cards* — D-23's reason, unchanged: whether a card renders would say what that person can see, and
the card would vanish when they left. *A second GitHub App for sign-in* — D-179 built sign-in on the OAuth
app and nothing here needs it moved. *The installation token for writes* — every issue would be by "Purlay",
and any member could write anywhere the App can reach. *A GitHub OAuth app's `repo` scope for writes* — it
reaches every repository the person can, private ones included, and cannot be limited to the App's.
*Believing the installation id in the callback's query* — it is a number anybody can type. *Keeping the
installation's authorization code's token* — it would make connecting also a consent nobody gave.

**Cost of reversing.** Remove the cards, the routes and the App's address; drop the six columns and four
tables of `0075` (`github_app_*`, `github_user_authorizations`). The workspace token, the feeds and sign-in
never read them.
