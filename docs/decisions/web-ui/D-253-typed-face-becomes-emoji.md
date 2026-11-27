# D-253. A typed face becomes its emoji, and Backspace takes it back — builds on D-110, D-188

**Context.** People type `:D` and `:)` out of habit, and in a chat those read as the emoji they mean in every other
messenger. The composer already had a picker; it had no answer for the face typed by hand.

**Decision.** In the composer (`features/composer/emoticons.ts`), a face from a fixed list — `:)` `:D` `;)` `:(`
`:P` `:O` `:'(` `<3` `xD` and some thirty more — becomes its emoji **when the word ends**: at a space, a new line or
the send.

1. **Only a face that stands alone**: at the start of the text or after a space. `:Dosya`, `http://a.b:D` and `(:D`
   are left as written. Case counts: `:d` and `xd` are not faces.
2. **Never inside code** — an open fence, or an odd count of backticks earlier on the line — where `:)` is
   somebody's syntax.
3. **Backspace straight after** the change puts the face back as it was typed, with its space, and that one stays: the
   space is already there, so nothing turns it again. Another face elsewhere still turns.
4. **Only what is typed.** A paste, a draft brought back, or a message edited later is not touched; what is sent is
   ordinary text, so the server, search and the other clients know nothing of it.

**Rejected.** *Turning as soon as the face is complete* — `:Dosya` would become 😄osya before the person had finished
the word. *A setting to turn it off* — Backspace answers the single time it is unwanted; a setting can come when
somebody asks for one. *Turning it on the server* — it would change words people sent from any client, code
included, without their seeing it first.

**Cost of reversing.** One module and three lines in the composer.
