# D-223. A code reference is a link into the channel's repository — its one GitHub feed's

**Decided (the owner, 2026-10-31).** A path with a line (`src/retry.ts:14`) or a commit's SHA in a stack
trace or a "see foo.ts:14" should be one click from the code. Which repository it means is the channel's
GitHub feed's (D-134): with exactly one feed, that repository; with none, or several, no file is linked —
choosing among several would be a guess. No new setting and no migration.

- **Drawn, not stored.** The reference is found as the words are drawn (`codeLinksIn`, `@purlay/markdown`,
  called by `render-content.tsx` in prose and inline code), from `Channel.codeRepository` — an additive field
  of the channel the client already holds, read in the channel list's one statement by a scalar subquery on
  the feeds' `(channel, repository)` key, null for a direct message. It is told to whoever can see the
  channel, who already reads that feed's events in it. Nothing goes into the message's metadata: the
  repository is the channel's now, not when the words were sent. The feed list (`GET …/github-feeds`) stays
  an owner's or an admin's.
- **What is a reference.** A path ending in a known source extension (`ts`, `py`, `go`, `md`, `yml`, …),
  with an optional line: `:14`, `:14:7`, `:10-20`, `#L14`, `#L10-L20` and the compiler's `(14,5)`; a leading
  `./` is dropped. It starts where nothing path-like precedes it — a letter, digit, `.`, `/`, `\`, `@`, `#`,
  `:`, `~`, `$`, `%`, `+`, `-` or an invisible format character — so an absolute path, a URL's path, an
  address and the tail of a longer word are never cut into a shorter reference; a first directory with a dot
  in it is a host (`github.com/…`), and `node_modules` is not the repository's. A bare file name with no
  directory is a reference with a line, or inside inline code; in prose alone (`Node.js`) it is a word. A
  commit is 7–40 lower-case hex with at least one letter and one digit, standing alone: not a number, not
  `decade`, not `#a1b2c3`, not a piece of a UUID or of a longer hash, not `owner/repo@sha`. A version
  (`1.2.3:4`) and a time (`10:30`) have no extension. Covered case by case, Turkish text and punctuation
  around a reference included, in `code-references.test.ts`, and timed linear over 16,000 characters.
- **Where it goes.** A path opens `https://github.com/<owner>/<repo>/blob/HEAD/<path>#L<n>[-L<m>]`: GitHub
  serves `HEAD` as the repository's default branch (checked on 2026-10-31: `blob/HEAD/README` answers `200`),
  which the client cannot know without asking. It is the file as it is now, so a line written against an
  older commit may have moved; a branch name would be as much a guess, and the commit is not known. A bare
  name, whose directory is not known, opens GitHub's code search in the repository (`repo:<owner>/<repo>
  path:<name>`), and loses its line. A SHA opens `/commit/<sha>`. A link to a full GitHub address, and
  `owner/repo@sha`, are what they were.
- **Never in a fenced block.** A fence is code to read and copy, numbered and coloured token by token; a link
  inside it would take a click meant to select, and a trace pasted in one mostly holds absolute paths that
  would link to the wrong place. Never inside a link's label either.
- **Built, never taken.** The address is made from the repository, checked against
  `GITHUB_REPOSITORY_PATTERN` (anything else links nothing), and the path, each segment encoded on its own;
  a `.` or `..` segment never matches, so it cannot step out of the repository, and what is built must pass
  `SafeHref.of` and be https on github.com under the repository, or it is a defect, thrown, and the body is
  shown as typed. Nothing is fetched to check a reference: a link that ends at GitHub's 404 costs a click,
  a request on render would cost every reader and tell GitHub who reads what.
- **Drawn as a link** (`UX.md` §3, §9): underlined, not colour alone, in either theme; a new tab without the
  referrer, said to a screen reader; a stop for the keyboard among the row's controls (D-168).
- **When the feed changes.** The admin who connects or disconnects one reads the channel list again, and
  their references follow at once; everybody else's follow the next time their channel list is read. A feed
  changes rarely, and until then a reference opens the repository the channel had.

**Considered and rejected.** Finding references on the server and storing them in the message's metadata
(stale as soon as the feed changes, and a derivation every old row would lack); asking GitHub whether a file
or commit exists (a request per reference per reader, under GitHub's limits); a per-channel repository
setting (the owner chose the feed, which already says it); the first of several feeds (a guess); linking
inside fenced code (above); a bare word with an extension in prose, and upper-case SHAs (too many words and
numbers). One false positive is accepted: a repository named like a file in prose (`vercel/next.js`) is
linked into the channel's repository, where GitHub answers 404.

**Cost of reversing.** `code-references.ts` and its call in `render-content.tsx`, the hook beside
`useChannels`, the line in `github-feeds.tsx`, and the field: `codeRepository` is additive, so removing it is
a contract change an installed client may rely on — stop drawing first, then deprecate the field.
