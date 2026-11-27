# D-293. Public link cards decorate readable chat messages with bounded metadata — builds on D-34, D-101, D-170

**Context.** A chat used by warehouse, purchasing, operations and office teams needs ordinary public document
and article links to be understandable beside a conversation. The existing GitHub cards answer a narrower
need and require a workspace credential. A general proxy or an unrestricted origin read would expose internal
networks, spend unbounded resources and tell a website who was reading.

**Decision.**

1. **A current message is the authority.** The chat-owned POST route names a message, resolves the current
   reader's channel/workspace visibility, then re-reads undeleted, personally unhidden content before caching
   or fetching. Its requested normalized URL must be one of the shared rendered AST's first two distinct
   eligible documents. Code, existing GitHub item cards, picture links and this app's origin are excluded.
   It acknowledges nothing. Invalid shape is a validation error; inaccessible messages share the existing
   message refusal; unsupported or absent links and unavailable decorative metadata answer JSON null.
2. **One bounded public document.** Named HTTPS hosts on the default port, no userinfo or address literals.
   Every resolved address must pass the existing public-address policy and the connection uses that checked
   lookup without socket reuse. No redirect, cookies, authorization or referrer. Fixed HTML headers, identity
   encoding, HTML MIME, UTF-8, at most 256 KiB and five seconds per fetch. Bun HTMLRewriter reads title/meta
   elements without executing a DOM or loading subresources. It returns raw entity references, so the server
   declares pinned BSD-2-Clause `entities` for its distinct text and attribute decoders; the chat Markdown
   engine intentionally does not decode these references (D-101). Text is stripped of forbidden control/bidi
   characters, whitespace-normalized and clipped without a dangling surrogate; the shared response validates
   title 200 and description 400 UTF-16 units and an optional safe HTTPS image address.
3. **Shared work has a bound.** Reuse `link_previews` and its expiry sweep, with a versioned, workspace-specific
   SHA-256 key over the fragmentless document. Positive answers live five minutes, negative answers one.
   Revalidate cached payloads. Per controller, coalesce same-key misses, run four origin jobs and hold eight
   waiting jobs, retaining at most twelve unique promises. Capacity skips do not poison the cache. Slots and
   pending entries are released on failure. Each fetch has its own deadline; a queued RPC may span three
   batches. Hold no database transaction over origin work. Use the costly-read bucket, independently of sends.
   Logs contain the host and workspace, never arbitrary transport reasons or a full secret-bearing address.
4. **A quiet chat decoration.** A cheap HTTPS text hint can load the optional feature code; the shared AST
   alone selects actual candidates, and only when their message is visible. A local render boundary keeps
   unavailable decorative code from replacing the conversation. Missing cards reserve no layout height.
   Fetch only after the server has
   accepted the message and while it is visible, keep mounted results when it leaves the viewport, and use
   five-minute/one-minute client freshness.
   Display the actual destination hostname and retain the original link and fragment; ignore site identity,
   base and canonical claims. Render plain React text, optional description and a decorative image through
   the existing checked/re-encoding image proxy. Failure leaves the source link usable without an error card.
   Edits remove their old candidates; hidden/deleted messages and revoked channels cancel and remove cached
   and pending metadata. Reconnects do not fan out origin reads: this family follows its HTTP TTL.

**Rejected.** Fetching arbitrary supplied URLs, parsing raw message text with a second link regex, unbounded
queues, shared cross-workspace metadata and browser-origin image loads would weaken existing boundaries.
A broad HTML/DOM dependency and per-page provider adapters are unnecessary for this metadata-only slice.

**Cost of reversing.** Remove the additive route, response, rendering and versioned cache reads. Messages and
existing GitHub cards are unchanged; old generic cache rows expire through the existing sweep. No migration,
index, credential or workflow subsystem is introduced.
