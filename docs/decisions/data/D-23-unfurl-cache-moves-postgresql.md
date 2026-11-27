# D-23. Removing Redis moves the unfurl cache into PostgreSQL

`ARCHITECTURE.md` previously cached GitHub unfurl responses in Redis with a 300s TTL. D-7
removed Redis, and that cache cannot simply disappear — without it every paste of a popular PR
link re-hits the GitHub API and burns the workspace's rate limit.

**Decided:** a `link_previews` table keyed by a hash, with `expires_at`. Reads are a primary
key lookup; expiry is enforced in the query and swept by a periodic job. This is slower than
Redis and entirely fast enough at our scale. *Amended 2026-11-01 (#884):* the hash is not of the URL
alone but of the workspace, the token's version and the URL (D-112 §1), and the five-minute card and
hour-long negative are constants in `unfurl.ts` — no `UNFURL_*_TTL` variable exists, and `CONFIG.md`
no longer lists one.

**Also decided:** GitHub API credentials are **workspace-level**, not per-user. Unfurling with
the viewer's own token would leak which private repositories a given member can see, based on
whether the card renders. One workspace token means every member sees the same card or no card.

**Amended 2026-11-01 (#884), after the integration's audit.** The token is a fine-grained, read-only
personal access token on selected repositories, and the server now says what it learns of it:
1. **It is checked when it is saved.** `GET /rate_limit` (no quota) at `GITHUB_API_URL` — the address the
   sign-in uses, so one setting says where GitHub is — before anything is stored, outside the
   transaction and after the caller's role is known. GitHub's `401` is `400` on the `token` field; a GitHub
   that cannot say (unreachable, failing, rate limiting) is `503 GITHUB_UNAVAILABLE`; either saves
   nothing and leaves the token that was there. The `X-OAuth-Scopes` header is kept
   (`github_integrations.token_scopes`), and a classic token with `repo` or a write scope is shown to admins
   as broader than cards need. A fine-grained token sends no header and is what is asked for.
   The write then locks the workspace and checks the caller’s current membership and role again, so
   revocation during the provider check takes effect. Both setting and removing return the existing
   public `GitHubIntegration` status from that transaction; no credential is returned or cached (#1179).
2. **A token GitHub refuses is shown, and not used.** A `401` on a card writes `token_invalid_at` on the
   row it was read from (not on a replacement that landed while the call was out); Settings → Integrations
   tells admins, `configured` stays true, no call is made with it and no card is served from the cache
   until the token is replaced or removed, which clears it. It is a state, not a cache entry, because an
   expired token stays expired however long a minute is.
3. **A spent quota pauses the workspace.** A `403` or `429` that says when to come back — `Retry-After`,
   or `x-ratelimit-remaining: 0` with `x-ratelimit-reset`; a bare `429` a minute — stops calls for that
   workspace until then, at most an hour, and nothing is cached for the link. The pause is held in the
   process, as the call budget is (D-81, D-25): a node that has not learned of it learns it from its first
   refused call, so what sharing it would save is one request a node. A `5xx`, a network error, a plain
   `403` (a repository's refusal, not the token's) and an answer that is not a card stay what they were:
   no card for that link for a minute (D-112 §3).
4. **Cards are for github.com links only** (`GitHubLink`); the requests go to `GITHUB_API_URL`. A GitHub
   Enterprise Server's links are not cards, and the Enterprise setting is for sign-in.
**Rejected:** conditional requests (`ETag`) — a `304` still spends the primary quota's request on a
secondary-limit-sensitive path and the five-minute card already bounds it; no measurement asks. *A pause
shared through the database* — nothing needs it before a second node (D-25).
