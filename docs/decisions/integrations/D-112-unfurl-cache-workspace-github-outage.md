# D-112. The unfurl cache is the workspace's, and a GitHub outage is held off for a minute

D-23 moved the unfurl cache into `link_previews`, keyed by the URL's hash, and `SCHEMA.md` §8.2 said
the endpoint would keep private repositories' cards to the workspace whose token fetched them.
Keyed by the URL alone, nothing in the table could: a card fetched with workspace A's token for a
private repository was a cache hit for workspace B pasting the same link — a private title, an
author and a state shown to people with no access. Served by #66; decided in the owner's standing
instruction to decide and proceed, and open to their reversal.

**Decided.**

1. **The key is the workspace, the token's version and the link** — the SHA-256 of the workspace id, a
   newline, the integration row's `updated_at` as an ISO string, a newline and the URL. A card is the
   workspace's, fetched with its token; a negative is too, since a link missing for A's token may be
   there for B's. The token's version is in it so nothing remembered under a replaced token is read under
   the new one (the entries expire as every entry does). The table stays unscoped by column; the scoping
   is in the key. (*Corrected 2026-11-01, #884:* the first text left the version out; the code had it
   from #66.)
2. **What is fetched is built from parts.** The request names a `GitHubLink` — github.com, an owner,
   a repository, `pull` or `issues`, a number — and the API address is made of those, so no address a
   person wrote is ever fetched. A repository named `.` or `..` is refused: resolved, it would step out
   of `/repos/{owner}/{repo}` and send the workspace's token to another GitHub path (found in review).
3. **GitHub failing, or answering what is not a pull request or issue, is no card for a minute**, logged
   at `warn`: a five-minute card and an hour's negative (§8.3) are for answers; an outage is held off
   so every render does not ask again, and a GitHub that recovers is asked within a minute.
4. **A token that does not open** (`ENCRYPTION_KEY` changed) is logged at `error` and no card is
   drawn — never a token silently treated as absent, and never a 500 for a link.
5. **GitHub refusing the token is not GitHub failing** (*added 2026-11-01, #884; see D-23*). A `401` marks
   the token bad and stops the calls, a `403`/`429` that names a time pauses the workspace until it, and
   neither is cached as a minute of "missing"; everything else in §3 is as it was.

**Rejected: sharing public cards across workspaces** by caching a card unscoped when its repository is
public. Whether a repository is public is itself something only a token can see, and a repository
made private after the card was cached would keep showing; the saving is a request per workspace.
**Rejected: CI status and review decision on the card** in this slice: each is another request per
unfurl against the same rate limit, and the card is useful without them.
