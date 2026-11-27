# D-252. Every letter is one short note with one button — builds on D-138, D-179 §5, D-240

**Context.** Every letter the server sent was its plain text wrapped in `<p>` tags, with the address it was about
written out in the middle of a sentence. It read as a machine's, the address was the biggest thing in it, and on a
phone a sign-in link was a long line to aim a thumb at. Every team product's mail now has a button.

**Decision.** All of them — the sign-in link, the word to an account GitHub or Google made, an invitation, the
administrator's verification, the relay's test and the missed-messages letter — are composed by one function,
`composeLetter` (`platform/letter.ts`), from blocks: paragraphs, headings, groups of lines, small notes and **at most
one button** for the one thing to do. The page is a white one, a column at most 480 pixels wide, a dark button
(`#18181b`, the interface's ink), small grey notes, signed *— Purlay*, and the button's address written out at the foot
for a client that shows no buttons. The plain-text part says the same blocks in order, the button as its words and its
address.

1. **Every character is escaped**, as before: a block holds words and the server's own addresses, and nothing a
   person typed becomes markup or a link. Names and excerpts are still `quotable` first.
2. **Inline styles and tables only.** Gmail and Outlook drop a `<style>` block, and Outlook lays out nothing else
   reliably; no class, no web font, no script.
3. **No image.** Most clients block remote images until asked, and a logo that does not load is a broken box at the
   top of a sign-in letter. The signature names Purlay instead.
4. **Light only.** The page declares `color-scheme: light`, so a client in dark mode shows it as drawn rather than
   inverting half of it.
5. **The missed-messages letter** keeps its content (D-240): each conversation is a heading and its newest lines, each
   line ending in a small *Open* link to that message; the button opens Purlay, and the link that stops the letters is
   a note at the end.

**Rejected.** *A card on a grey page with a coloured header* — the look of a newsletter, the one thing a sign-in letter
should not resemble, and more for Outlook to break. *The brand blue button* — the interface's primary is blue, but
in a letter a dark button reads as the one action without suggesting an advertisement. *An HTML template file per
letter* — eight copies of the same page to keep escaping right in. *A logo* — see 3.

**Cost of reversing.** One file: `composeLetter` decides the page; the letters only name their blocks.
