# D-40. The database is created with a deterministic collation, and `citext` is dropped

Migration `0001` runs in Phase 0, and two identifier rules in `SCHEMA.md` quietly depend on the
locale the operator happened to pass to `initdb`.

`idx_channels_unique_name` is `UNIQUE (workspace_id, lower(name))`. In PostgreSQL, `lower()`
follows the collation of its argument. Under a Turkish locale `lower('İ')` does not produce `i`,
and `I`/`ı` fold differently than they do under `C`. **Channel-name uniqueness would therefore
depend on how the server was provisioned** — the same two names could collide on one deployment
and coexist on another. For a product that will run on machines we do not control *and* in a cloud
we do, that is not acceptable.

**Decided: identifier columns carry an explicit `COLLATE "C"`** — `channels.name`,
`workspaces.slug`, `users.username` and `users.email`. Byte-wise, deterministic, identical
everywhere. Message `content` keeps the database default; linguistic ordering never applies to it,
and trigram matching is unaffected.

**`citext` is dropped.** The extension existed only for `users.email`, and it lowercases using the
database locale — the same defect one column over. Email becomes `TEXT COLLATE "C"`, normalised
(trimmed and lowercased as ASCII) at the application boundary before it is ever stored or compared.
One fewer extension, and `CONTRIBUTING.md` §1.12 prefers exactly that.

**`/health/ready` asserts the expected collation**, so a mis-provisioned database fails at startup
rather than at the first colliding channel name.

**Also settled: the vestigial text-search line in D-10.** D-10 said the search configuration
*"becomes `simple`, not `english`"* and then dropped the `tsvector` column and its index entirely.
With no `tsvector` there is no text search configuration at all. The sentence is removed; the
trigram index is the whole story.

**Rejected — leaving it to documentation.** "Create the database with `LC_COLLATE=C`" in an
operator guide is a rule that holds until somebody uses a managed provider that does not offer it.
A column-level collation travels with the schema.

**Amended 2026-10-09: what a name may contain (second-round attack).** Identifier text handling had
a collation and no alphabet: `{"name":"a\u0000b"}` on a workspace or channel was a `500` and an error
report, because PostgreSQL cannot store a NUL and the contract did not say so (message content did).
A **`name`** format now refuses, at the contract, in workspace and channel names: every control
character (C0, DEL, C1 — a name is one line, so tab, line feed and carriage return too), the line
and paragraph separators, a lone surrogate, and the **bidirectional embeddings, overrides and
isolates (U+202A-202E, U+2066-2069)**. Bidi controls are refused rather than normalised because a
name is an identifier people read and compare by eye: an override makes one name display as another
(`gpj<RLO>exe.txt`), and an unclosed isolate reorders what follows it in the sidebar. The
directional *marks* (U+200E/200F) stay, because a right-to-left name in a left-to-right interface
needs one. A **`plain-text`** format covers a channel topic: multi-line is fine, what PostgreSQL
cannot store is not. A workspace slug already was a whitelist (`^[a-z0-9][a-z0-9-]*$`) and never
held any of this — tested. GitHub's `name` is not refused (sign-in never fails on a value GitHub
controls, #233): the same set is *removed* and an emptied name falls back to the login.
