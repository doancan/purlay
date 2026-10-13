# Purlay — Interaction Specification (`UX.md`)

> Authority: `PRD.md` owns *what* ships. This file owns *how it behaves* — layout, states,
> keyboard model, and the interaction rules for the resolvable thread.
>
> **Why this document exists:** Purlay's differentiator is not a feature, it is a behaviour.
> "Threads resolve" is three sentences in the PRD and an entire interaction model in
> practice. Building Phase 0's UI without settling this risks building a shape Phase 1 has to
> undo.

---

## 1. Principles

1. **The feed is the product.** The conversation happens in one column, and a thread opens
   *beside* it, in a panel on the right, never in a modal that hides the conversation behind it
   (D-122). What keeps a thread from becoming a footnote is that its root stays in the feed with its
   live status — open or resolved — and the open questions are one click away.
2. **Density over comfort.** This is a tool for people who read a lot of text quickly. The
   density is in what is shown — one column, no chrome, nothing decorative — not in how tightly it
   is set: prose gets a readable line, and the screen gets nothing else. (D-110)
3. **Keyboard first, mouse optional.** Every action reachable by mouse has a key. The command
   palette is the primary navigation surface, not a power-user extra.
4. **Never move content under the reader.** Late-arriving content, an opening thread and
   resolving images must not shift what someone is currently reading. (§6)
5. **State is always visible.** Sending, failed, unread, resolved, offline — each has a
   distinct, non-decorative visual. A message whose delivery state is ambiguous is a bug.

---

## 2. Layout

One fixed shell, flat: a rail and a sidebar in one dark navy tone (D-118), the channel on the window's ground, and an
optional members column. No resizable panes in Phase 1 — a saved layout is one more state to sync
for no benefit at this size. Regions are separated by tone and one hairline, not by boxes (D-110).

```
 ┌────┬──────────────────┬────────────────────────────────────────────────┬─────────┐
 │    │                  │ # api  Backend API…     (Feed)(Questions 3) ⍟ │         │
 │ AE │ Acme Engineering │────────────────────────────────────────────────│ members │
 │    │ ⌕ Search… ⌘K     │ Today ──────────────────────────────           │ (opt.)  │
 │ ▢  │ Channels         │ (SC) Sarah Chen  09:14                         │         │
 │ ✉• │  # api           │      Here's the updated session hook…          │  200px  │
 │ ?3 │  # deploys    2  │      ┌ ts · 14 lines ──────────── Copy ┐       │         │
 │ ⌕  │ People           │      └─────────────────────────────────┘       │         │
 │    │  (SC) Sarah Chen │ ┌──────────────────────────────────────┐       │         │
 │ ⚙  │ (DÖ) you         │ └────────────────────────────────── ➤ ┘       │         │
 └────┴──────────────────┴────────────────────────────────────────────────┴─────────┘
```

- **Rail (56px)** — the workspace tile, which opens the workspace switcher; then channels, the
  inbox (a dot while anything needs you — the same fact as the mention badges, D-106), open
  questions (a neutral count: they are the team's, not a summons) and search; at the foot,
  settings — theme, language and the shortcut reference. Every entry is a route or a menu that
  exists without the rail; it adds no destination. Its top is an empty drag strip for the desktop
  shell (D-14).
- **Sidebar (240px)** — the workspace name, the jump field (the palette's door, `⌘K`), the channels,
  then the people, and your own row at the foot. Unread channels are bold;
  unread **mentions** carry a count badge. Nothing else gets a badge. A person has an avatar and no
  presence dot: there is no presence to show (Phase 2, D-120), and a dot that is always one colour
  would be a lie.
- **Channel** — header, feed, composer, in that order, one column. The header names the channel and
  carries the two views as a segmented control: the feed, and **open questions** with its live count,
  which is the product's argument and so is always one click away.
- **Feed** — the single column. Max width 760px, hung from the left edge beside the sidebar, so the
  eye does not travel back across the window to find where a line starts.
- **Member list** — collapsed by default. Presence is decoration, not information.
- **Thread panel (380px)** — on the right of the channel, only while a thread is open (§4, D-122).
  The feed keeps the rest of the width.

- **The tab's title** — `<place> · <workspace> · Purlay`: `#channel`, the other person's name in a
  direct message, or the screen's name. While anything needs the person it starts with the same count
  as the mention badges, `(3) `, and with nothing at zero or in Deep Work (D-106). It is the only
  signal a tab in the background has in Phase 1.

**Below 900px** the rail and the sidebar become one overlay and the channel fills the window. An
open thread covers the channel — header and composer included — and its close control is the way
back; what it covers is hidden from a screen reader and from Tab until it closes.
Purlay is not a mobile product in Phase 1 (`PRD.md` §4), but it must not be broken on a narrow
window.

**Invitations** (D-115). An invitation is an address, `/invite#…`, that somebody pastes into the
chat the team already uses.
- **Opening one** shows a card like the sign-in screen's: the workspace's name, until when the link
  opens, and **Join**. A person already in it is offered **Open** instead. A person not signed in
  signs in first and comes back to the same card. The token leaves the address bar as the page loads,
  so it is not left in the history or a screenshot. A link that does not open says so in one
  sentence — expired, revoked, or never real look the same — and offers the way home.
- **Making one** is an owner's or an admin's: **Invite people…** in the workspace menu opens a dialog
  with **Make a link**, the link once made with **Copy**, and the links still open — who made each and
  until when — each with **Revoke**. A member does not see the entry.

**Members** (`ARCHITECTURE.md` §7.4). **Members…** in the same menu lists everyone in the workspace
with a role each: a labelled select where the person may change it, the role in words where they may
not — an admin does not touch an owner or make one, and nobody changes their own row. **Remove** asks
in the row first, because it costs the person every channel. The last owner is said as such.

**The audit log** (D-26). **Audit log…** in the same menu, an owner's or an admin's, reads the trail
newest first, a page at a time: each entry a sentence — *Doğancan changed Alice's role from Member to
Admin* — and when. An action newer than the client is said by its name, never dropped.

**The GitHub connection** (D-23). **GitHub connection…** in the same menu, an owner's or an admin's
too, gives the workspace its one token: a password field and **Save token**, then *Connected since …*
with **Disconnect**. The token is never shown again — the field empties once it is saved — and without
one a link to GitHub stays a plain link, which the dialog says.

---

## 3. The message row

```
  (a) Alice  14:32                                   [☺][↩]
      ╭───────────────────────────────────────────────╮
      │ The retry backoff is 4s because the upstream  │
      │ rate-limits at 15/min.                        │
      │ ┌──────────────────────────────── ts ─┐       │
      │ │ const backoff = 4_000;       Copy   │       │
      │ └─────────────────────────────────────┘       │
      ╰───────────────────────────────────────────────╯
      👍 3   🎉 1
      ○ Open · 4 replies · last 12m ago      Show thread T

                                                   14:35
                          ╭───────────────────────────╮
                          │ Ship it — I'll watch CI.  │
                          ╰───────────────────────────╯
```

- **A GitHub pull request or issue linked in the words is a card under them** (D-2, D-23): the
  kind, `owner/repo#number`, its state in words, its title as a link that opens in a new tab, who
  opened it, and for a pull request its checks (a glyph and a word) and its review decision when
  GitHub has them — never their avatar, which is another host's image (#110). Up to five, in the order
  written. A link with no card — no token, nothing there, GitHub silent — stays a link, with nothing
  drawn and nothing said.
- **A link to a picture is the picture, under the words** — up to three, in the order written, each a
  link to the original, drawn through the API's proxy so the picture's host never sees who is reading
  (#110). One the proxy cannot show draws nothing; the link stays a link.
- **Two edges, in bubbles** (D-119, amending D-100). Everyone else's messages are on the left in a `surface-200`
  bubble, with an avatar in a fixed column; your own are on the right in an `accent-subtle` bubble,
  with no avatar and no name. A bubble is at most five sixths of the feed; a code block keeps its own
  card inside it. The channel's feed and composer are centred.
- **The header line** is over a group's first bubble: the name and the time on the left, the time
  alone on the right, the time in the mono face.
- **Consecutive messages** from the same author within 5 minutes hide the avatar and the header;
  their time shows on hover, in the avatar's column on the left and beside the bubble on the right.
  The avatar belongs to the group's first message, so a message arriving below never changes one above.
- **Hover controls** are a small raised group on the bubble's inner top corner (on a narrow window,
  your own message's outer one — D-119 §6) and never reflow the row; the row itself is not tinted. Only the row under the pointer shows its own: a reply in the
  thread panel is a row of its own.
- **A message that mentions you** has a 2px accent edge on its bubble, and says so to a screen reader.
- **Timestamps** are relative under an hour, then `HH:mm`, then `MMM D`. Absolute time on hover.
- **Reactions** sit below the content, above the thread affordance.
- **The day** is a label at the column's left edge with a rule after it. (D-110)

### 3.1. Delivery state

| State | Appearance | Behaviour |
|---|---|---|
| `sending` | Full opacity, subtle clock glyph beside the time | Paints in < 16ms, before any network call (`PRD.md` §5) |
| `sent` | Glyph removed | On `ACK`. **The row does not move** — the id was final from the start (D-8) |
| `failed` | The bubble's left edge in the error colour, "Retry · Delete" inline | After 3s with no ACK. Never disappears silently |

The `sending` state is deliberately **not** dimmed to 50% opacity. Dimming implies "not real
yet"; in an optimistic UI the message *is* real, and flickering opacity on every send is visual
noise on the most frequent action in the product.

---

## 4. Threads — the wedge

### 4.1. In the feed

A root message with replies shows one line beneath it:

```
  ○ Open · 4 replies · last 12m ago                     Show thread T
```

Clicking it, or pressing `T` on the focused message, opens the thread **in the panel** on the
right (D-122). The affordance is absent when there are no replies — an empty thread control on
every message is clutter that teaches people to ignore that region. While a root's thread is in
the panel, its line is filled and says **Thread open**, so the eye finds where the panel came from.

### 4.2. The panel

```
  ┌ Thread · #api ─────────────────────────── × ┐
  │ (AC) Alice  14:32                           │
  │      ╭ The retry backoff is 4s because… ╮   │
  │ ○ Open · 4 replies · last 12m   [Resolve ⌘⇧R]│
  │ ─────────────── 4 replies ───────────────── │
  │ (BO) Bob  14:35                             │
  │      ╭ Is that documented anywhere? ╮       │
  │                 ╭ Only in the postmortem. ╮ │
  │ ╭──────────────────────────────────────╮    │
  │ │ Reply…                             ➤ │    │
  └─╰──────────────────────────────────────╯────┘
```

- **One thread at a time.** Opening another replaces it. A channel opened again opens with no
  thread, unless its address names one (`?thread=`, from the open questions, the inbox and search),
  which opens even when its root is older than the feed's first page.
- **The header** names it — *Thread · #channel*, or the person's name in a conversation — and its
  close control (`Esc`) closes it.
- **The root**, its status and **Resolve / Reopen**, a rule labelled *N replies*, then the replies as
  the feed draws them: two edges, grouped by the same rule (§3). The reply box is at the bottom, and
  keeps its draft per thread like the channel's (§5). There is no "also send to the channel": the
  product has no such thing.
- **Focus**: opening moves it into the panel — the heading, or the reply box after Reply or `R` —
  and closing puts it back on the root's row in the feed. The panel is a complementary region
  labelled by its heading.
- Thread depth is capped at two levels by **invariant I-1** (`SCHEMA.md` §11), which owns the
  rule. The interaction consequence is what belongs here: a reply has no thread affordance of
  its own, so the limit is never something a user can bump into. Unbounded nesting is how a
  thread becomes unreadable.

### 4.3. Resolving

`Resolve` is available to any member (`ARCHITECTURE.md` §7.4) on the **root** message only.

On resolve:
1. Resolved from the panel or the root's row while it is open, the thread folds away with a short
   animation and the panel closes — the only place in the product with a non-instant transition,
   because a state change that reorganizes the reader's view needs to be *seen* to be understood.
   Focus returns to the root. Resolved by somebody else, an open panel stays and only its status
   changes (D-122).
2. The affordance line becomes `✓ Resolved by alice · 4 replies`.
3. A `system_event` message is **not** posted. The resolution is metadata on the root, not
   another line of chatter in a product whose thesis is less noise.

A resolved thread still opens on click, still appears in search, and never hides its
parent message. Reopening is the same control, inverted.

### 4.4. The open-questions view

Reached from the palette (`Cmd+K` → "Open questions") or the workspace header. It lists
unresolved root messages that have at least one reply, workspace-wide, newest first, grouped by
channel — backed by `idx_messages_unresolved`.

This view is the product's argument in one screen: *these are the questions your team has not
finished answering.* Slack cannot produce it at any price. It ships in Phase 1, not later.

---

## 5. Composer

Plain textarea, GFM, no WYSIWYG toolbar (`PRD.md` §4.1). Three buttons sit under it — bold, a code
block, a mention — and each only *inserts markdown* that the keys below also produce (D-110).

| Key | Action |
|---|---|
| `Enter` | Send |
| `Shift+Enter` | Newline |
| ` ``` ` then `Enter` | Opens a code block; `Enter` inside it inserts a newline, `Cmd/Ctrl+Enter` sends |
| `↑` on an empty composer | Edit your last message |
| `Esc` | Cancel edit / close the thread panel / close palette |
| `@` | Member autocomplete — **`@here` and `@channel` are not offered and are rejected on send** (D-12) |

Pasting an image uploads immediately and inserts a placeholder; the message can be sent while
the upload is still in flight. Pasting over ~12 lines of text is inserted as a fenced block
automatically, with an undo toast — a paste that silently becomes a code block with no way back
is worse than no help at all.

**Drafts** persist per channel in `localStorage`. Losing a half-written message on a channel
switch is unforgivable in a tool people live in.

**Who else is typing** is said quietly in the channel composer's footer, beside the hints — "Alice is
typing…", two by name, more as "Several people are typing…" — in a row that is always there, so nothing
moves when it appears (D-114). Never yourself; gone when their message arrives or after a few quiet
seconds. A reply composer shows none: typing belongs to the channel.

---

## 6. Scroll and unread

The hardest problem in the product, and the subject of **O-5**.

**Rules that hold regardless of how O-5 is decided:**

- **Anchor on read position, not on bottom.** If the user is scrolled up, incoming messages must
  not move the viewport. A "N new messages ↓" pill appears instead.
- **Stick to bottom only when already at bottom** (within 80px).
- **Opening a thread moves nothing in the feed**: it opens beside it. Inside the panel a reply
  arriving near the end keeps the end in view, and a reader further up is left where they are.
- **The unread marker** is a horizontal rule labelled "New", placed at
  `channel_members.last_read_message_id`. It persists while the channel is open — it does not
  vanish the instant the messages are seen, because it is the reader's place-holder, not a
  notification.
- **Marking read** happens when the bottom is reached, or on channel exit. Never on mere render.

**On O-5:** variable-height rows defeat naive virtualization, and a
wrong guess here is expensive. Phase 1 ships **unvirtualized with a 50-message window** and
paginates on scroll. Virtualization is adopted only if dogfooding shows a measurable problem,
against the `< 100ms` channel-switch budget in `PRD.md` §5. Building it speculatively would
trade a certain cost for a hypothetical benefit.

---

## 7. Keyboard model

| Key | Action |
|---|---|
| `Cmd/Ctrl+K` | Command palette — channels, DMs, people, settings, open questions |
| `Cmd/Ctrl+/` | Shortcut reference |
| `Esc` | Close the topmost thing — palette, then edit, then the thread panel (focus returns to its root) |
| `↑` `↓` | Move message focus |
| `T` | Open the focused message's thread in the panel, and move focus there |
| `R` | Reply to the focused message |
| `E` | Edit (own messages) |
| `Cmd/Ctrl+Shift+R` | Resolve / reopen the focused thread — on its root, or anywhere in its panel |
| `Alt+↑` `Alt+↓` | Previous / next unread channel |
| `Cmd/Ctrl+Shift+D` | Toggle Deep Work |

Focus is **always visible** — a 2px ring, never `outline: none`. This is a keyboard-first
product; an invisible focus ring is a broken product, not a style choice. (`PRD.md` §5)

---

## 8. Required states

Every view implements all four, **and a test asserts each one renders** (D-53). An unhandled empty
state is an incomplete feature, not a polish item (`CONTRIBUTING.md` §4) — a screen missing one is
missing specified behaviour and does not merge.

| View | Empty | Loading | Error |
|---|---|---|---|
| Channel feed | "No messages yet" + composer focused | Skeleton rows, no spinner | "Couldn't load messages · Retry" — the composer stays usable |
| Search | "No matches for `<query>`" + scope hint | Inline progress in the input | Retry, query preserved |
| Notifications | "Nothing needs you" | Skeleton | Retry |
| Open questions | "Every thread is resolved" | Skeleton | Retry |
| Thread | n/a — never rendered empty | Skeleton under the root, in the panel | Retry in the panel, root intact |
| Invitation | n/a — a link always names a workspace or says it does not open | Skeleton card | "This invitation does not open" + the way home; any other failure, Retry |
| Sign-in | n/a — always the one button | n/a — nothing is fetched before the click | One sentence per reason a sign-in came back unfinished (`API.md` §2): what happened, then what to do, above the same button (D-121) |
| Open invitation links | "No links are open" + **Make a link** | Skeleton rows | Retry |
| People (sidebar) | "Nobody else is here yet" under your own row + **Invite people…** for an owner or an admin | Skeleton rows | Retry |

**A screen that fails to draw** is replaced by "This screen stopped working" with **Reload** and
**Go home**; the rail and the sidebar stay, and going anywhere else draws afresh. A failure outside a
screen says "Purlay stopped working" with the same two ways out. Never a blank page (D-96).

**Connection loss** shows a single non-blocking bar: `Reconnecting…`. The composer stays
enabled — messages queue and send on reconnect (`ARCHITECTURE.md` §5.4). Disabling input on a
transient network blip is the failure mode this whole architecture exists to avoid.

**Deep Work** shows a persistent, quiet indicator in the header with its expiry. A mode you can
forget you are in is a mode that loses you messages.

---

## 9. Visual system

Decided here so Phase 0 does not invent one at random.

> **These values are tokens, and the tokens are the only source.** Colour, spacing, type scale,
> radius, shadow, motion duration and easing are declared once, in `packages/tokens/tokens.json`,
> and consumed through the theme; a literal in a component is a lint error. What makes an
> interface look designed rather than assembled is the absence of a way to be inconsistent.
> (D-52, D-97) The numbers quoted in this document are the file's, repeated where a diagram
> needs them, and a test fails if they drift.

- **Type:** Inter for prose and JetBrains Mono for what is machine text — code, a time, a count, a
  key, a hash — served from this origin in Latin and Latin Extended (the Turkish letters are in the
  second) with a system stack behind them while they load (D-110). Base 14px, code 13px, line-height
  1.6 prose / 1.54 code.
- **Colour:** dark and light ship together (D-98), the OS preference until a person chooses, the
  choice kept per device. Both are designed together: neutral greys, one blue accent and a navigation
  that is dark navy in both, with dark derived in the same terms (D-110, D-118). Every colour pair is computed in both. Never colour alone
  to carry meaning: resolved, failed and unread each pair colour with a glyph or weight, for contrast
  and colour-blindness both.
- **Contrast:** WCAG AA minimum, including code syntax tokens, which are the usual casualty.
- **Motion:** quiet. Hover and focus ease in 120ms, the palette opens in 150ms, the thread folds
  on resolve (§4.3) and the reconnect bar slides. No message entry animation — at conversational
  speed it reads as lag. Everything is instant under reduced motion.
- **Radius / elevation:** 6px for a control, 8px for a row, 10px for a card, 12px for the composer
  and an overlay. The interface is flat: regions are told apart by tone, and only what sits above
  something — an overlay, the hover controls, the composer, a card inside a message — has a shadow.

---

## 10. Not in Phase 1

Custom themes · resizable panes · message pinning · saved items · reminders · rich link previews
for non-GitHub URLs · emoji picker beyond a recent/frequent row · read receipts · user status
messages · threads in a popped-out window.

Some are permanent non-goals (`PRD.md` §6); the rest are simply not the wedge.
