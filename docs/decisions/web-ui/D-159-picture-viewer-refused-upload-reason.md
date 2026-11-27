# D-159. A picture opens in a viewer; a refused upload says why

**Amends D-109 §6 and D-129, and `UX.md` §2, §3 and §5.** The owner's audit of messaging (2026-10-19):
a click on an image left the app for the raw `/api/attachments/…` file in a new tab (F7), and a failed
upload said only "Didn't upload · Retry", whatever had gone wrong (F8).

**Decided.**

1. **An image opens the image viewer**, from the feed and from the Files panel alike: the picture over
   the whole window, fitted to it — never cropped, never enlarged past its own size — with its name, who
   shared it, its size and when, **Download** and **Open original** (a new tab), and Close. Esc, the close
   button and a click beside the picture close it, and focus goes back to the thumbnail. It is a Radix
   dialog (focus moves in and stays in, the page behind is hidden from a screen reader); the viewer takes
   the first focus itself, and **Esc is the viewer's whatever is focused** — a control's tooltip does not
   take the first one (#623's trap, closed here at its source for this surface). The thumbnail stays a
   link to the image, so ⌘/Ctrl-click and the middle button still open a tab. Any other file still
   downloads.
2. **←/→ step through the pictures it was opened from** — a message's, or the Files panel's as far as the
   panel has read (no page is fetched for it: the panel's list is already the channel's newest-first
   index, and reading more is the panel's Load more). It stops at either end rather than wrapping, and the
   controls keep their place there, so the picture never moves under the pointer. Not the whole channel's
   pictures from the feed: the feed holds a window of fifty messages, so "the next picture" would depend
   on what happened to be loaded.
3. **On the navigation's tone** (D-118): the viewer is dark in both themes, so a picture is judged against
   the same ground whatever the theme and the chrome recedes. Not the `scrim`: the page behind showing
   through a picture is noise, and `UX.md` §1's rule against a modal that hides the conversation is about
   reading — a picture is opened on purpose and left with one key.
4. **The viewer is deferred**, with the settings, in one chunk: `apps/web/src/app/deferred.ts`, asked for
   with `import()` on the first open and on pointing at or focusing a thumbnail, so it is usually there by
   the click. *Measured:* with the viewer in a chunk of its own the bundler (rolldown under Vite 8) did not
   fold what two lazy chunks share with the entry back into it — it emitted a third, preloaded chunk of
   every module that reaches React — and the first page grew by 2.9 KB gzipped, 1.9 KB more than the
   viewer itself weighs. In one chunk with the settings it costs the first page nothing; the price is that
   the first picture opened also fetches the settings' code, once, ahead of the click. A later deferred
   feature joins that module rather than becoming a second `import()`. A viewer that does not arrive says
   so in a toast and nothing opens. *Amended by D-163:* the build now keeps every initial module in the
   entry, so a second lazy chunk no longer costs the first page; the rule of one deferred chunk stays,
   because the shell preloads it once when the browser is idle.
5. **A refused upload says why, in words, from its code**, under the file's name in the chip: too large
   (with the limit), an image past the side or pixel bound (with them), an image that does not decode, a
   type refused, the workspace's storage full (with **the room left**), too many files waiting, no
   connection, the server busy, file storage unavailable, the session ended. Anything else is "Didn't
   upload". The mapping is a switch over every code, so a new one is a compile error until it is placed.
   **Retry is offered where trying the same bytes again can be answered differently**, and not for too
   large, an image past the bounds, one that does not decode, or a type refused — there the one control is
   Remove, which every chip keeps.
6. **`STORAGE_QUOTA_EXCEEDED` carries `details.remainingBytes`**: what the quota leaves after what is
   stored and what is waiting to be sent, never below zero. It is the workspace's own number, told to a
   member of it who is uploading into it; it is at most the size of the file refused, so it says nothing
   about the quota beyond "not this file". Optional in the contract, as `LAST_OWNER`'s details are, so a
   client reading an older server says "Workspace storage is full" without the room.

**Rejected.**

- *A lightbox library*: D-52's bar for a dependency; Radix's dialog already is the hard part.
- *Zoom and pan*: Open original is one click away, at the browser's own zoom; a viewer that zooms has to
  own touch gestures, and that is a feature of its own.
- *Swipe between pictures on a phone*: the same; the arrows are touch-sized there.
- *Retry on every refusal*: a button that can only fail again teaches people that it does nothing.

**Cost of reversing:** `messages/image-viewer.tsx`, `image-viewer-door.tsx`, `app/deferred.ts`, the
thumbnails' click in `attachments.tsx` and `files-panel.tsx`, the chip's words in `composer/uploads.tsx`;
the quota's `details` is an optional field nothing else reads.
