# D-105. What a search finds, and what it is asked with

D-10 fixed the index and the scope; nothing fixed what a search *means*. Served by #63.

**1 · The words as typed, ignoring case, anywhere in a message.** `ILIKE '%words%'` on
`idx_messages_search`. `%`, `_` and `\` are what the person typed, escaped before they reach the
pattern: a search for `100%` is not a search for `100`. Nothing is stemmed, split or ranked (D-10).

*Amended 2026-10-15 (#700):* "ignoring case" now means by Unicode. Under the database's C ctype
`ILIKE` folded ASCII alone — "çağrı" did not find "ÇAĞRI", "istanbul" not "İstanbul". Both sides are
folded by `purlay_fold` — ICU's root lowering, then I ı İ i as one letter — and compared with `LIKE`
on `idx_messages_search_folded`, built on the same expression. Rejected: *a language's own lowering*
(Turkish lowers I to ı, every other language to i, and one workspace writes both); *a database
created with an ICU locale* (a fresh cluster for every deployment, and identifiers would stop comparing
byte-wise, D-40).

**2 · A trigram at least, and a bounded length, after trimming** (`SEARCH_QUERY_MIN`,
`SEARCH_QUERY_MAX` in `@purlay/types`). Below a trigram the index cannot narrow anything, so a
two-letter search is a scan of the workspace; the maximum bounds the pattern a request may hand to
the database. A query outside them is `400 VALIDATION_FAILED`, never an empty page.

**3 · Roots and replies, open threads and resolved ones; never a deleted message.** A resolved thread
is the answer somebody will come looking for (#38). A deleted message's words are not on any screen,
and search must not be the way back to them (D-103).

**4 · Only in the channels the caller can see** (D-34), asked of the guard once per request and
narrowed in the query, never filtered afterwards. `channelId` narrows to one of them; one the caller
cannot see — another workspace's, or a private channel they are not in — is `404 CHANNEL_NOT_FOUND`,
not an empty page that confirms it exists.

**5 · Newest first, `before` and `limit`, no `after`.** A result list is read from the top; there is
no live tail of a search to follow forwards.

**Rejected: a minimum of one or two characters.** The scan is the cost D-10 refused to pay on the
send path, moved to the read path. **Rejected: words matched separately, in any order.** It is a
query language, and D-10's argument against stemming applies: a person pasting an identifier wants
that identifier. **Rejected: `channelId` outside the visible set answered as an empty page.** It is
the 403-that-confirms-existence in another form.
