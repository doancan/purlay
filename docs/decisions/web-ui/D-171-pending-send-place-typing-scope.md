# D-171. A send waiting on its files is the place's, not the composer's; a reply box and a non-member are not heard typing

**Amends `UX.md` §5 and D-114.** An audit of main (2026-10-20) found two things the composer said it did and
did not. *Send while an upload is in flight* held the send and the files in the composer's own state, and
the composer is remounted on a channel switch (`<ChannelView key=…>`) and unmounted when a thread's panel
closes: the words came back as a draft, the files and the send did not — a person who pressed Send and
moved on believed something had gone that never would. And a thread's reply box announced typing to the
channel, so its members read "Alice is typing…" and nothing ever arrived in their feed; the server let
anybody who could *see* a public channel announce there, though only a member may send (D-156).

**Decided.**

1. **The files and the waiting send are held per place, above the composer** — keyed as the draft is (a
   channel, or one thread in it), for the life of the signed-in page (`features/composer/outbox.ts`, mounted
   in the shell below the engine). A channel switch, another screen of the workspace or a closed panel
   loses neither; going back shows the files with their state and *Sends when the files finish uploading*.
2. **While a composer for the place is on the screen, it sends; while none is, the outbox does**, the moment
   the last file lands: the words the box held when it went, with the files, to where they were written,
   and the draft is cleared as a send from the box clears it. The row then paints and reconciles like any
   other send (`CONTRIBUTING.md` §1.9).
3. **A file that fails while nobody is looking holds the send back, and says so at once** in a toast naming
   the place — *Not sent to api: a file did not upload. The message is still there.* — and it is: the words,
   the files and the reason, with Retry and Remove, when the person goes back. Nothing is sent without a
   file the person attached.
4. **A reply box does not announce typing.** `UX.md` §5 already said a reply composer shows nobody typing,
   because typing belongs to the channel; it now also says nothing to it. No thread-scoped indicator is
   specified, and none is built: a `TYPING` frame names a channel only.
5. **The server hears typing only from a channel member.** A visible non-member's announcement is dropped,
   answered with nothing as every announcement is, and takes no place in the registry.

**Rejected.**

- *Keep the composer mounted per channel, hidden.* Every channel visited would hold a live composer, its
  effects and its member list; and it does not cover a thread's panel, which is closed, not hidden.
- *Refuse to switch, or ask, while a send is waiting.* It turns a promise the composer made — send while it
  uploads — into a dialog the person did not ask for, at the moment they chose to move on.
- *Send what is ready and drop what failed.* A message that arrives without the file it was about says
  something other than what was written.
- *Survive a reload.* The files are in the page's memory; keeping them across a reload means writing blobs
  to the browser's storage, a client-side store D-7 refuses without a measurement. A reload still keeps the
  words (the draft).

**Cost of reversing:** `composer/outbox.ts`, its provider and hook in `composer/uploads.tsx`, the provider in
`shell.tsx` and the two test trees; one condition in `composer.tsx` and one in `realtime/router.ts`; their
tests and mutation entries. No contract or stored fact depends on any of it.
