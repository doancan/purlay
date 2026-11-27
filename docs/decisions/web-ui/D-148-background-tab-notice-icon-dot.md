# D-148. An open tab in the background tells its person: a notice, a dot on its icon

**Context.** With Purlay open in a tab that is not in front — another tab, another window — the only
sign that something needed the person was `(N)` in the title (D-106, #491), which a pinned tab does not
show and anybody can miss. Web Push (D-126) reaches a closed tab, but D-143 holds a push while the
person's page is open, and it needs the operator's keys: an open tab in the background was told nothing.
Slack's loop is a banner, a badge and a sound.

**Decision.**
1. **What interrupts is what the badge already counts — nothing is classified twice.** A conversation's
   `unreadMentionCount` going up while the page is open is a new thing that needs the person (`NEEDS_YOU`:
   a mention, a direct message, an answer in a thread they are part of, a channel at `all`). A
   resolution is told in the inbox and not counted (D-106 §2), so it does not interrupt either; the
   person's own messages never move their badge. `NEEDS_YOU` moved to `@purlay/types`, one list for the
   server's send, read and delete and for the client.
2. **A notice from the page itself**, through the browser's `Notification` — no worker, no server key —
   for desktop output only while the page is hidden or not focused, never in Deep Work, never on the first look at a list
   (what was waiting when the page opened is not news). **Who and where, never what** (D-126 §2): the
   title is the place (`#api`, the person, a group's people), the body the inbox's own words for why,
   read from the inbox's newest page; a click focuses the window and opens what the inbox row would —
   the thread for a reply. Unread, it says only where.
3. **Coalesced, not a storm.** One tag per conversation, so its next notice replaces its last; several
   conversations rising at once (a reconnect, a busy minute) are one notice, "3 conversations need you",
   opening the inbox. A conversation read elsewhere takes its notice back.
   **Amended 2026-11-09 (#1331):** each eligible new background notice requests `renotify`, so replacing
   a notice can alert again without accumulating notices. Ordinary private messages need no explicit
   mention or channel-wide opt-in. Device opt-out, mute, Deep Work, quiet hours and focused-page silence
   remain; unsupported browsers can ignore the preference. The browser capability and limits are
   recorded in `docs/spikes/web-push.md`.
4. **One switch.** "Notifications on this device" (D-126) now covers both: offered wherever the browser
   has notifications, it asks the browser once, and where the browser has push and the server has keys
   it also subscribes. It is on while the person who turned it on is signed in here and the browser still
   allows it; a permission taken back turns it off on the next load. The page never asks on load.
   **Amended 2026-10-28 (#796):** while on, a device test requests a browser notice, reporting only
   that the browser accepted it, with permission/device-settings guidance on refusal. The test checks
   permission again; a revocation turns the switch off before any request. It creates no message,
   requires no new endpoint, and changes no channel preference. Both the feed and an open thread
   count as read only while the page is visible **and its window is focused**; blur/focus are observed
   alongside visibility, so an unread notice is not cleared while the person is in another window.
   **Amended 2026-11-09 (#1331):** every explicit device test uses a fresh notification tag and retires
   its previous test, so repeated clicks request a new alert rather than silently replacing one.
   Asynchronous browser refusal replaces the requested message with a failure; a superseded,
   disabled or unmounted test cannot report a late failure. This still does not certify OS banner
   display or its timing. Conversation notices retain their coalescing tags.
5. **A dot on the favicon, and the app's badge.** While the title counts, the tab's icon is
   `favicon-waiting.svg`: the favicon with a dot in `danger`, ringed in `on-accent`, bound to the
   tokens by `favicon.test.ts` as the favicon is; and an installed app's icon carries the count
   (`navigator.setAppBadge`, optional by its type where Firefox lacks it). Zero, or Deep Work, puts
   both back.
6. **Independent delivery preferences (amended 2026-11-09, #1348).** A focused page in a different
   conversation may show one actionable in-app notice and a short, user-unlocked chime. Reading the
   conversation stays quiet. In-app cards, sound and desktop permission are independent device
   choices; channel eligibility, Deep Work and quiet hours apply to all. The app never plays its
   chime alongside a desktop notice: the OS owns that sound, requested silent when sound is off.
   The same sound choice is saved on the push subscription for a closed tab. An optional `sound`
   field expands the subscription contract, defaulting true for existing rows/new owners; an old
   client omitting it preserves the same owner's explicit choice. The additive push `silent` field
   is optional for compatibility with yesterday's worker. Device preferences are bounded, validated
   personal storage, synchronized between tabs and cleared on sign-out; no message contents are
   stored. Web Locks arbitrate focus and serialize a bounded recent-notification claim list so
   multiple tabs do not repeat an alert. Without shared coordination, focused in-app alerts may
   work locally, but background page alerts fail closed; closed-tab push remains available.
   The browser may block audio until interaction and may ignore native sound preferences; UI never
   promises an OS banner or an audible sound.
   The measured initial bundle is about 256 KB of the unchanged 400 KB backstop. Forwarding's
   existing dialog joins the existing idle-preloaded deferred overlay chunk (D-163), keeping
   chat below its unchanged 50 KB bound (D-277); its ownership stays in chat. No screen is moved
   into the shell and no budget is raised.
7. **Small and late.** What tells is loaded the first time there is something to tell; the
   always-loaded part is the comparison of two lists of numbers and the swap of an icon.

**Rejected.**
- *Reading each `MESSAGE_CREATED` for mentions, direct messages and thread membership* — a second
  definition of "needs you" beside `NEEDS_YOU`, which D-106's amendment already refused for the title.
- *Pushing to the open tab* (lifting D-143's hold for a hidden page) — it needs the operator's keys and
  a worker, and costs a round trip through a push service for what the page already heard on its socket.
- *A second switch for the open tab* — one browser permission, two controls that can disagree.
- *Drawing the dot on a canvas from the linked favicon* — tried first: the picture is a `data:`
  address, which the page's `img-src` refuses (D-39), as the browser suite showed. Loosening the
  policy for a dot is the wrong trade; a second same-origin file costs four hundred bytes.
- *A dot in the accent* — the favicon is filled with it, and the dot would vanish.
- *A count drawn on the favicon* — illegible at sixteen pixels; the title says the number.
- *A sound, on or off by default* — above; and off by default it is a setting nobody finds.

**Accepted.** Chrome on Android refuses a page's `Notification` (only a worker may); there the page in
the background is not running anyway, and push is what tells a phone. A tab tells only of its own
workspace: the socket watches that workspace's channels.

**Cost of reversing:** `features/alerts`, `features/push/notifier.ts`, the shared switch in `push.tsx`,
two catalogue lines; no migration, no endpoint.

**Amended 2026-11-26 (D-339).** The favicon and its waiting variant (item 5) are now the owner's mark on a white
tile instead of the accent tile with a white P: the dot is still `danger`, now ringed in the tile's white, and
`apps/web/src/favicon.test.ts` holds the two pictures to the brand file and the tokens rather than to the accent.
