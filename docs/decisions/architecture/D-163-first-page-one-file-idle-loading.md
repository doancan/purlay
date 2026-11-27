# D-163. The first page is one file, and what is opened on purpose comes when the browser is idle — amends D-159 §4

**Context.** The initial JavaScript stood at 246.72 KB gzipped of the 250 KB budget (D-49), so the
next feature would not have fitted. Measured from the build with its source map, the 246.72 KB were
six files: the entry, and five chunks the bundler (rolldown under Vite 8) cut from it because the lazy
chunks share modules with it — every one preloaded by `index.html`, so all of it was downloaded
anyway. The one called `es2015` was the markdown engine and Radix's dialog machinery, named after
`react-remove-scroll`'s `dist/es2015` folder; nothing in it was a dependency loaded by mistake.

**Decided.**

1. **Every module the first page needs is in the entry** — one file. A `codeSplitting` group in
   `vite.config.ts` takes every module the `$initial` tag marks, except the push worker's, which is an
   entry of its own and stays one file that imports nothing (D-126). *Measured:* the same modules in one
   file are 5.30 KB gzipped smaller than in six (246.72 → 241.42 KB): one compression dictionary instead
   of six, and no import and export lists between them. It changes nothing a person sees; the lazy
   chunks are still lazy.
2. **What a person opens on purpose joins the deferred chunk** (`app/deferred.ts`): the command
   palette, the shortcut reference, New channel, Browse channels, Invite people, New message, a group's
   details and Add people. *Measured:* a further 5.38 KB (241.42 → 236.04 KB) — 10.68 KB in all.
3. **Nothing visibly waits, because the chunk is fetched when the browser is idle.** Once the
   signed-in shell is drawn it asks for the chunk with `requestIdleCallback` (at most two seconds), or
   after two seconds where there is none (Safari) — `app/deferred-door.ts`. ⌘K has no pointer to
   preload on, so an idle preload is the only way to have the palette there by the time it is asked
   for; one fetch, after the first screen, covers every door. An overlay asked for before the chunk has
   arrived is drawn the moment it lands. A chunk that does not arrive says so in a toast and the
   overlay stays closed; the next request asks again.
4. **Before the chunk arrives an overlay is not mounted; after, it stays mounted** — open or closed,
   as it was in the first chunk, so it keeps its closing animation and its state. The data a closed
   dialog asked for (the invitations list) is asked for when the chunk lands, not with the first screen.
5. **D-159 §4's reason for one deferred chunk is gone, and the rule stays for a new one.** Two lazy
   chunks no longer push what they share with the entry into a third, preloaded chunk — §1 puts all of
   it in the entry. A second deferred chunk would be a second preload to remember, so a later deferred
   feature still joins `app/deferred.ts`.
6. **The shape is checked** with the number: `bun run budget:web` fails when the initial modules are
   in more than one file (a locale catalogue beside the entry is allowed, D-41) and when
   `push-worker.js` imports anything.

**Rejected.**

- *Deferring the markdown engine* (about 20 KB): every message on the first screen is drawn from it,
  so the feed would wait for it or be drawn twice.
- *Deferring Radix's menu, tooltip and dialog primitives*: the message actions, the tooltips and every
  menu are on the first screen, and a trigger drawn before its primitive would lose its ARIA until the
  chunk came.
- *Deferring the list screens* (the inbox, saved, search, open questions): a screen is reached by a
  link, and a link that waits for a chunk is a navigation that waits; the overlays came to enough.
- *Raising the budget*: D-49.

**Cost of reversing:** the group in `vite.config.ts` and its two checks in `scripts/budget-web.ts`;
`app/deferred-door.ts`, the exports added to `app/deferred.ts`, and the door at each overlay's place
(`global-keys.tsx`, `channel-list.tsx`, `conversation-list.tsx`, `people-list.tsx`,
`workspace-menu.tsx`, `channel-header.tsx`). No stored value depends on it.
