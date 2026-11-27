# D-101. One markdown engine on both sides, narrowed to what the product renders, and bounded — closes O-6

O-6 left the two markdown packages D-36 named as categories, and #42 and #43 are the moment they
are needed. Decided by the owner on 2026-10-11, on the measurements in `docs/spikes/markdown.md`.
Each number below is measured there; the bounds themselves are constants in the code, named here.

**1 · One engine.** `mdast-util-from-markdown` (micromark) with four GFM extensions —
autolink literals, strikethrough, tables and task lists — on the server at write time and in the
browser to render. It is the engine `remark-parse` wraps; its trees and remark's were identical on
every probe, and with one engine there is no second parser to
keep aligned, so D-36's shared fixture suite becomes the package's own tests. Its browser cost is in
the spike. The reading lives in
`packages/markdown` (`@purlay/markdown`), which a lint rule keeps free of anything a browser cannot
run.

**2 · Narrowed: the narrowing is the sanitiser.** The engine is configured never to recognise raw
HTML, reference definitions, images, indented code, setext headings, character references or
footnotes; what it does recognise is copied into a tree of the kinds the product draws and nothing
else (`packages/markdown/src/tree.ts`). A link is a link only to an absolute `http:`, `https:` or
`mailto:` URL; anything else is its label's text. An image is a link to the image, labelled with its
alt text, until the proxy exists (#110). Stored content stays markdown (D-36 §2): the server cannot
make stored markdown safe for a renderer it does not run, so the narrowing is applied where a tree
is made — on the server for metadata, in the browser for rendering — and both run the same function.

**3 · Headings are emphasis.** `#` makes a heading, drawn at the body's size in bold: a heading in a
conversation is emphasis, not a title, and a full-size one breaks the feed's rhythm. Decided by the
owner, with *as typed* and *a real heading* rejected. *Amended 2026-10-26 by D-189:* a heading has a size by its level (still not a heading element).

**4 · Code is a fence.** Four spaces are indentation; only a fence makes code, so an indented log or
the continuation of a list is not turned into a block without a language. Decided by the owner. The
same reasoning switches off the setext underline: only explicit syntax formats.

**5 · Bounded, and a body past a bound is shown as typed — never refused.** The engine is
superlinear on runs of inline delimiters and on unbroken address-like runs (its autolink pass
backtracks), and slow or out of stack on containers opened on one line, inconsistently
(`docs/spikes/markdown.md`). So a body is formatted only inside four bounds, each a constant in
`packages/markdown/src/scan.ts` or `parse.ts`: containers opened on one line
(`MARKDOWN_NESTING_MAX`, with a line ended by `\r\n`, `\r` or `\n`, as the engine ends one),
inline delimiters outside code (`MARKDOWN_DELIMITERS_MAX`), the longest address-like run outside
code (`MARKDOWN_RUN_MAX`), and the depth of the narrowed tree (`MARKDOWN_DEPTH_MAX`). Where code is,
is the engine's own block reading, never a pattern: the first version of this bound was one, and the
agreement test showed it could not follow a fence inside a list item.
A body past a bound is still sent, stored and searchable; it is not formatted. Refusing it was
rejected: it would make a pasted log a failure, a retry after the bounds tighten a different answer
from the first (D-8), and a new error the composer must explain.

**6 · GitHub links: a bounded few per message** (`GITHUB_LINKS_PER_MESSAGE_MAX`), unique and
canonical, in the order they appear. Each becomes a request to GitHub when it is unfurled (#66).
Decided by the owner (five, with ten and three rejected). `metadata` is not on the wire until
something reads it (#44, #66).

**7 · A mention is looked for where the reader sees prose.** The mention parser kept rules of its
own for code and missed a `~~~` fence, so a name quoted in what renders as code notified the person.
The body it reads now has every fenced block the engine reads blanked, so what is drawn as code and
what notifies cannot disagree.

> **Amended 2026-10-12 (#330).** Blanking fences was not enough: the server still stripped inline code
> with rules of its own, so a link labelled `@bob` and `https://medium.com/@bob` notified bob, and a backtick pair
> across a blank line was code to the server and prose to the engine. A mention is now a name **in the
> prose of the tree the client draws** (`proseNames`, `@purlay/markdown`): not in code, not in a link —
> its label or its address — and not glued to the end of either. The server resolves those names, the
> composer refuses a broadcast among them, and the client highlights exactly those occurrences; a test
> renders bodies at every edge and requires the highlight to be the server's names. A body the engine
> does not format (shown as typed, §8) is still read as typed, and is drawn with no highlight.

**8 · The engine failing inside the bounds is a defect, not a refusal.** It is caught around the two
engine calls only — a defect in this package's own code throws — and returned with its cause. The
message is stored and shown as typed, and the server logs an error with the cause and never the
content. Rejected: re-throwing, which would make a body the bounds should have caught a failed send;
and catching around the whole reading, which hid this package's own bugs as the engine's.

**9 · A link carries the address as the browser reads it** (`new URL(…).href`), so the string that
was checked is the string that is rendered. Making an unchecked link impossible to construct — a
brand on the tree, the way D-54 brands a context — belongs with the renderer that consumes it (#43).
*(Amended 2026-10-11, #43: the brand is on the address, not the tree.)* A link's `url` is a
`SafeHref` (`packages/markdown/src/href.ts`): a class whose constructor is private and whose one
factory, `SafeHref.of`, is the check, with a private field that makes the type nominal. An object
literal, a string, or a spread of a real one is not a `SafeHref`; the instance, its prototype and the
class are frozen. An assertion to one is a lint error with no exemption, as D-54's is for a context,
and inside `packages/markdown` any assertion is, because a cast to a node that holds an address
(`as unknown as Inline`) skips the check without naming it. A rule by name cannot see an alias or a
type guard, so the renderer checks `instanceof SafeHref` too, drawing the label as text when a link
fails it: types and lint stop the mistake, the check at the point of use holds against it. Rejected: *D-54's symbol key on the tree's
root*, because a spread copies a symbol key, so `{ ...tree, children: [any link] }` would type-check
as a checked tree — the brand guarded the container, and the danger is one field inside it; and *a
branded string*, which cannot be produced without the very assertion the lint rule forbids, so the
rule would need an exemption in the file that matters most. D-54 rejected a class for a context
because a context must survive serialisation; a tree is built where it is drawn and is never sent.
The shape of a mention (`mentionsIn`) lives in the same package for the same reason as §7: the
server resolves the names it matches, and the renderer highlights with the same pattern, which
retired the client's own copy — it disagreed on any letter outside ASCII.

**Rejected.**

- *Two engines (remark and `marked`).* D-36's original plan. `marked` is 13.3 KB and faster on the
  worst inputs (16 ms), but it is a second reading of the same characters, held to the first by a
  fixture suite that can only test the cases somebody thought of.
- *Extending the hand-written parser.* No dependency, and a grammar the size of GFM to own.
- *A sanitising serialiser to HTML, or `dangerouslySetInnerHTML` behind DOMPurify.* A second
  representation (D-36 §2) and a renderer that trusts markup; the narrowed tree is rendered as
  elements and has no markup in it to be wrong about.
- *Running the parse in a Worker with a timeout.* It bounds time but not the stack, costs a thread
  per process, and a body that times out on a slow machine formats on a fast one.

**Cost of reversing.** Low: no migration, and stored content is unchanged markdown. A different
engine means a different `packages/markdown`, and its tests say what the next one must do.
