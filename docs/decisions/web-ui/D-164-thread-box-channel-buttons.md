# D-164. A thread's box has the channel's buttons; an upload refused for a workspace left says so

**Amends D-110 §8, D-159 §5, and `UX.md` §5.** The owner's audit of messaging (2026-10-19): in the thread
panel the composer had no buttons — no bold, code block, mention, and no way to attach a file but a paste
or a drop — while the channel's had all four. Nothing decided it: the reply box had been drawn as a
one-line field with the send button beside it when the card was introduced (#320), and the buttons were
added later only where there was room for them (#379). D-110 §8 says *the composer* has the three buttons;
a reply is a message like any other, and a file belongs in an answer as often as in a question.

**Decided.**

1. **The thread's box is the channel's box**: the words, the files under them, then one row of Bold, Code
   block, Mention and Attach, the length left, and Send. What it leaves out is what the panel's 380px
   (`size-thread`) has no room for or no use for: the key hints are not drawn — they stay the field's
   description, read by a screen reader — the send button is the square icon without the ↵ beside it,
   and who is typing stays the channel's (`UX.md` §5).
2. **An upload refused with `WORKSPACE_NOT_FOUND` says "You no longer have access to this workspace"**,
   with Remove and no Retry. The workspace answers somebody taken out of it, or a workspace that was
   deleted, as one that does not exist (404, never 403 — `CONTRIBUTING.md` §1.2), so the chip says the
   one thing true of both, and the same bytes would be refused the same way. It was "Didn't upload" with
   a Retry that could only fail again, which D-159's *Rejected* already refuses.

**Rejected.**

- *The buttons in a menu behind one "+"* — a click more for every file in a thread, and a control the
  channel's box does not have: two composers that look alike and work differently.
- *Hints wrapping onto a second row in the panel* — the box grows when it is focused, which moved what was
  under the pointer on a narrow window (#654); the panel is that narrow at every width.

**Cost of reversing:** the footer row's `compact` branches in `composer/composer.tsx`, one case in
`composer/uploads.tsx` and its two sentences; the tests and the two mutation entries that name them.
