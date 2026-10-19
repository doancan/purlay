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
 │    │ (DÖ) you       ⚙ │ └────────────────────────────────── ➤ ┘       │         │
 └────┴──────────────────┴────────────────────────────────────────────────┴─────────┘
```

- **Rail (56px)** — the workspace tile, a second door to the workspace menu; then channels, the
  inbox (a dot while anything needs you — the same fact as the mention badges, D-106, so in Deep Work
  it is not drawn, as they are not, D-15), open
  questions (a neutral count: they are the team's, not a summons), search, and **saved** — the
  messages you kept to come back to, in three tabs, In progress, Archived and Completed, each moved
  or let go from its row (D-128). Every entry is a route
  or a menu that exists without the rail; it adds no destination. At its foot a gear opens
  **Settings** (D-146). Its top is an empty drag strip for the desktop shell (D-14).
- **Sidebar (240px)** — the workspace name with a chevron, which opens the **workspace menu** (the
  workspaces to switch to, **Create workspace…**, and for an owner or an admin **Invite people…** and
  **Workspace settings**, D-146), the jump
  field (the palette's door, `⌘K`), the **starred** channels — a section of their own above the
  rest, by name, there only once one is starred, from **Star this channel** in a channel's header
  (D-132) — the channels, under a heading that carries **Browse channels** and **New channel**, always
shown in the section's quiet tone with a tooltip each, never revealed only under a pointer — the **conversations** — groups of up to ten
  people, each named by its people, and **New message** (`+`), which picks people ("To: …") and
  starts the conversation of exactly them (D-127) —
  then the people, and your own row at the foot, which opens the **account menu** (D-124, D-146): who
  you are; Deep Work for a while — 30 minutes, an hour, two hours or until tomorrow — or, while it is
  on, until when, the minutes left and its end; **Settings** (`Cmd/Ctrl+,`); the shortcut reference;
  and **Sign out**. Unread channels are bold;
  unread **mentions** carry a count badge. Nothing else gets a badge; a channel with an incident open
  carries its severity after the name, **SEV1** to **SEV4** — a state, not a count — said with its status
  to a screen reader (D-137). A person has an avatar, and a
  dot in its corner while they have Purlay open (D-136), said as "online" beside the name to a screen
  reader. Offline and not known are the same: no dot — a presence that failed to load draws nothing,
  never a team gone offline.
- **Channel** — header, feed, composer, in that order, one column. The header names the channel and
  carries the two views as a segmented control: the feed, and **open questions** with the live count
  of *this channel's* — never the workspace's, which is the rail's and the sidebar's — opening the view
  narrowed to the channel (§4.4). In a channel it is always there, being the product's argument; a
  conversation (a direct message or a group) carries it only while it has open questions, since an
  empty view there is one more control. The name is cut with an ellipsis before anything is drawn
  over it, and the topic gives way before the name. The channel's **name opens its
  details** (and so does the topic, for a pointer) — see *Channel details* below.
- **Feed** — the single column. Max width 760px, hung from the left edge beside the sidebar, so the
  eye does not travel back across the window to find where a line starts.
- **Member list** — collapsed by default. Presence is decoration, not information.
- **Thread panel (380px)** — on the right of the channel, only while a thread is open (§4, D-122).
  The feed keeps the rest of the width.
- **Files panel** — the same place, opened by the header's **Files** control (D-129): every file
  shared in the channel, newest first, each with who shared it, when and its size. An image shows its
  thumbnail and opens; any other file downloads; a file said in a thread opens that thread in the
  panel's place. One panel at a time: opening the files closes a thread, and a thread opening closes
  the files. Opening moves focus to the panel's heading; closing puts it back on the Files control.
- **On a narrow window** the Files and Pinned messages controls, and the channel's star, are one
  menu, **Channel menu**, so the channel's name keeps its room in the header.
- **A conversation with one other person** is headed by them: their name, which opens their
  **profile** in the same place — name, handle, title, status line, the time where they are and its
  zone — and, on a wide window, their local time and status beside the name (D-131). **Your profile…**
  in the account menu sets your own title, status and time zone, with this device's zone one press
  away; a field emptied is cleared. Where people are picked, each says their title and local time.
- **Pins panel** — the same place again, opened by the header's **Pinned messages** control (D-130):
  the channel's pinned messages, newest pin first, each with who said it and when, its words, and who
  pinned it; a pinned reply opens its thread, and a member unpins from the row. **Pin** sits beside
  Save on a message for a member of the channel, painted at once and put back with Retry when
  refused; a pinned message says **Pinned** under its words, for everyone who can see it.
- **Incident** — a channel's, never a conversation's (D-137). While one is open a banner under the
  header says its severity, its status and since when, and opens the **Incident** panel in the same
  place, as does the header's **Incident** control (in the Channel menu on a narrow window). In it a
  member of the channel sets the severity and moves the status between **Investigating** and
  **Mitigating**, each painted at once and put back, said, when refused; **Resolve…** asks first, since
  a resolved incident is never reopened. Who is responding is listed with their avatars, first brought
  in first — **I'm responding**, **Bring someone in…** from the channel's members, and **Take off** —
  and the banner shows the first three; somebody who left the channel stays listed. The **runbook** is
  a link opened in a new tab, linked, changed and removed by a member; the **postmortem** is drawn as
  a message is, and **Write**/**Edit** opens it in place — saved from the version it was begun at, so
  somebody else's save in between is said, their words shown above the person's own, which are kept to
  save again. A draft outlives the panel closing for as long as the page is open. Then what happened, newest first, in words. With none open
  the panel says so, when the last was resolved, and declares one at a severity. Somebody who sees the
  channel without being in it reads all of it and is offered none of the controls.

- **Edited** under a message's words is a button (D-135): it opens the message's **Edit history** —
  what it says now, then each earlier version, newest first, with when it was replaced, older ones a
  page at a time. Its author has **Remove** on each version, asking in place first; the edit box says
  that what a message said before stays in its history, where it can be removed. A message with none
  says they were not kept, or were removed; one deleted while its history is open says so there.

- **The tab's title** — `<place> · <workspace> · Purlay`: `#channel`, the other person's name in a
  direct message, or the screen's name. While anything needs the person it starts with the same count
  as the mention badges, `(3) `, and with nothing at zero or in Deep Work (D-106). The tab's icon
  says the same with a dot, which a pinned tab still shows (D-148).
- **What reaches a person, by where Purlay is** (D-148). What *needs* them is one thing everywhere —
  what the mention badges count: a mention, a direct message, an answer in a thread they are part of,
  a channel set to every message. Never their own messages, and in Deep Work nothing interrupts.
  - **The tab in front of them:** the page says it — the badges, the inbox dot, the title. Nothing
    pops up and no device buzzes (D-143).
  - **The tab open but not in front** (another tab, another window): the title's count, a dot on the
    tab's icon, the installed app's badge; and, with notifications on for this device, a notice from
    the browser — the place and who, never the words — one per conversation, the next replacing the
    last, several at once as one. Clicking it brings the tab forward on the conversation or thread.
  - **The tab closed:** nothing, unless the server has push and the person turned notifications on
    for this device — then the same notice reaches the device (D-126). Without push, the inbox has it
    all when they come back.

**Below 900px** the rail and the sidebar become one overlay and the channel fills the window. An
open thread, or the files, covers the channel — header and composer included — and its close control is the way
back; what it covers is hidden from a screen reader and from Tab until it closes.
Purlay is not a mobile product in Phase 1 (`PRD.md` §4), but it must not be broken on a narrow
window.

**The inbox** (D-106, D-153). What the person was told in this workspace, newest first, in one centred
column like the feed: **All** or **Unread** above it — Unread is asked of the server, so what waits is
found however old — then **Today** and **Earlier**, each a card of rows. A row says who, why and where,
with the message under it in two lines at most; unread is a dot at its edge and the line in full ink,
read is muted. Opening a row takes the person to the message and reads it; **Mark read**, beside the
row on a pointer's hover or a keyboard's focus, reads it without going; **Mark all read** in the header
reads what is on screen. A row read in the Unread view stays there, muted, until the person looks again,
so nothing moves out from under the pointer. Unread with nothing waiting says *All caught up*.

**Invitations** (D-115). An invitation is an address, `/invite#…`, that somebody pastes into the
chat the team already uses.
- **Opening one** shows a card like the sign-in screen's: the workspace's name, until when the link
  opens, and **Join**. A person already in it is offered **Open** instead. Joined, they are offered
  the workspace's public channels to join — the three busiest marked **Active** and picked — joined
  together in one press or skipped; a join that fails part way names the channels it could not join
  and keeps them picked (D-132). A person not signed in
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

**Channel details** (D-123). Clicking a channel's name in its header opens a dialog, drawn after the
Details panel of the Superdesign screens: the **name and topic**, editable by a member of the channel
with **Save** (somebody who has not joined reads them and is told to join) — the dialog opens with
focus on itself, never on the name, so a key pressed on opening renames nothing; no dialog opens with a
field's text selected; the **members** with a count
and **Add people** (the same dialog as the header's: the workspace's people, narrowed as typed, those
who can be added first with **Add**, and anybody already in the channel after them, saying *Member*
quietly with nothing to press, and a sentence above them when that is everybody); the **notification level** (the header's menu);
for an owner or an admin, the **GitHub repositories** the channel hears from (D-134) — each with what it
posts, its last delivery and why it last failed, **Disconnect** asking in place, and a form to
**Connect** one, which answers with the payload URL, the content type and the secret, each with Copy,
the secret said to be shown only now, until **Done**; and at the foot, in the danger tone, **Leave channel** for a member and **Archive channel** for an owner
or an admin. Each of the two asks in place first and says what it costs; done, the person is taken to
the workspace and told in a toast. The last member of a private channel is told to bring somebody in
first or ask an admin to archive it. A direct message between two has no details: its title is not a button. A group's title opens its
details (D-127): its people, you first, and **New conversation with these people…**, which opens New
message with them already picked — a group's people never change, so more people is a new
conversation.

**A channel's name is typed as it is said** (D-123). In **New channel** and in the details, what is typed is turned
into the name's form as it is typed — *Genel Sohbet* becomes `genel-sohbet`, *İstanbul* becomes
`istanbul`: lowercase, accents and Turkish letters folded to their plain letter, anything else one
hyphen (`features/channel/channel-name.ts`). Somebody looking at a channel that is archived, or that
they left on another screen, is told which, instead of *not found*.

**The GitHub connection** (D-23). **GitHub connection…** in the same menu, an owner's or an admin's
too, gives the workspace its one token: a password field and **Save token**, then *Connected since …*
with **Disconnect**. The token is never shown again — the field empties once it is saved — and without
one a link to GitHub stays a plain link, which the dialog says.

**Workspace settings** (D-124). **Workspace settings…** in the same menu, an owner's or an admin's,
renames the workspace: a name field and **Save**, and a sentence saying the address stays `/w/<slug>`,
so links already shared keep working. Saved, the name changes at once in the tab and, without a reload,
in every open tab of every member.

**Another workspace** (D-124). **Create workspace…** in the same menu, anybody's, opens the form `/`
shows a person with none — a name and an address — and goes to the new workspace, with Back to where
they were.

**Settings** (D-146). A page, `/w/<slug>/settings/<section>`, opened from the rail's gear, the
account menu, the workspace menu's **Workspace settings** and the palette. The sidebar's place holds
its navigation: **Back to <workspace>**, then **Account** — Profile, Preferences, Notifications,
Keyboard shortcuts, Sessions & account — and, for an owner or an admin, **Workspace** — General,
Members, Invitations, Integrations, Audit log, Data & retention. The current page is marked as the
current channel is. Each page: a title, one sentence, then cards; a setting is a row with its label and
a sentence on the left and its control on the right (stacked below 900px). A choice applies when it is
made; a form of words has **Save** in its card, enabled once something changed, its outcome said beside
it. On a narrow window the navigation opens as the sidebar does.

- **Profile** — what *Your profile…* held: title, status line, time zone with this device's one press away.
- **Preferences** — the theme (System, Light, Dark) and the language, each a set of choices shown at once.
- **Notifications** — Deep Work (start, or until when and end), notifications on this device (D-126,
  D-148) — one switch for the open tab's notices and, where the server has push, the closed tab's — with
  where a blocked browser undoes it, and what interrupts in Phase 1 in words (D-12, D-29).
- **Keyboard shortcuts** — the reference, as a page.
- **Sessions & account** — *Sign out everywhere…*, *Leave <workspace>…* (D-152; the last owner is told to
  make somebody else an owner first) and *Erase my account…*, each asking first.
- **General** — the workspace's name, its address (which stays), and *Create workspace…*.
- **Members** — a table: person, role, and actions, with a search field and a role filter above it;
  the rules of *Members* below hold unchanged.
- **Invitations** — making a link and the links still open, as *Invitations* below says.
- **Integrations** — the GitHub connection, as below.
- **Audit log** — the trail as a table, newest first, a page at a time.
- **Data & retention** — how long history is kept, and exports.

The sections below say what each does; where they say a dialog from the workspace menu, it is now the
page of the same name.

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
  card inside it, and a ` ```diff ` block is drawn as a diff — numbered lines, added and removed in
  colour and in words, **Unified** or **Split** on a wide window (D-133). The channel's feed and composer are centred.
- **A person is named by their name** — the display name, as the sidebar names them — wherever they
  are named in words: the feed, a direct message's header, the inbox, search, the open questions,
  *Resolved by …*, and what a screen reader hears of a row. The handle appears only where it is the
  point: an `@mention`, the profile's handle line, and beside the name where people are picked.
- **The header line** is over a group's first bubble: the name and the time on the left, the time
  alone on the right, the time in the mono face.
- **Consecutive messages** from the same author within 5 minutes hide the avatar and the header;
  their time shows on hover, in the avatar's column on the left and beside the bubble on the right.
  The avatar belongs to the group's first message, so a message arriving below never changes one above.
- **Hover controls** are one floating bar — hairline edge, the float shadow — on the row's own top
  edge, in the corner the message is not in: the right for everyone else's, the left for your own
  (D-150, amending D-119 §6). It never reaches above its row, so it never covers the row above or
  the name over a bubble; it never reflows the row, and the row itself is not tinted. **One bar on
  the page**, across the feed and the thread panel: the row under the pointer, or the focused row
  while the keyboard is in use; a row whose menu is open keeps its bar. On a phone the row tapped is
  the one.
- **The bar holds** React · Reply (a thread's root) · Save · Pin · More, each the same square
  control on every window, each with its tooltip and its key where it has one (Reply `R`). **More
  is on every message**: Copy text, Save and Pin again, then Edit (`E`) and Delete on your own; an
  owner or an admin may delete anybody's, told it goes on the audit trail. React opens the quick
  set as one row of tiles, the name of the one reached under it and yours marked as chosen, opening
  upward and kept inside the feed so it never covers the composer.
- **A message that mentions you** fills your own `@name` in the text, and says so to a screen reader;
  the bubble has no edge (D-119 §5, amended). A **quotation** is a recessed block with a quote glyph,
  never an edge, so the two cannot be mistaken for each other.
- **Timestamps** are relative under an hour, then `HH:mm`, then `MMM D`. Absolute time on hover.
- **Reactions** sit below the content, above the thread affordance. A chip's tooltip says who:
  "You, Alice and Bob reacted with 👍"; past three, two names and how many others (D-150).
- **Edited** and **Pinned** share one line under the words, apart from each other.
- **Save for later** sits beside React on any message the person can read (D-128): marked at once,
  put back and said with Retry if the server refuses; a saved message's mark is filled.
- **The day** is a label at the column's left edge with a rule after it. (D-110)
- **Copy link** is in the **More** menu of a message that has one — today one's own (D-149): the
  message's whole address on the clipboard, said with *Link copied*, or, when the browser refuses,
  that it could not be copied.

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
the panel, its line is filled and says **Thread open**, so the eye finds where the panel came from. Under your own message, which
sits on the right (§3), the line is mirrored: the status under the bubble's edge, **Show thread** at the
other end — never the status a column away from the bubble it is about.

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
  thread, unless its address names one (`?thread=`, from the open questions and the inbox), which
  opens even when its root is older than the feed's first page — or a reply's link does (§6).
- **The header** names it — *Thread · #channel*, or the person's name in a conversation — and its
  close control (`Esc`) closes it.
- **The root**, its status and **Resolve / Reopen**, a rule labelled *N replies*, then the replies as
  the feed draws them: two edges, grouped by the same rule (§3). The reply box is at the bottom, and
  keeps its draft per thread like the channel's (§5). There is no "also send to the channel": the
  product has no such thing.
- **Focus**: opening moves it into the panel at once, whatever its root's state — the heading, or the
  reply box after Reply or `R` once the root is there — and closing puts it back on the root's row in
  the feed. A root with no row there (opened from the files panel, the inbox or an address) gives it
  to what opened the panel, if that is still on the page, or else to the main region: never to
  nothing. The panel is a complementary region labelled by its heading.
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
2. The affordance line becomes `✓ Resolved by Alice Chen · 4 replies`.
3. A `system_event` message is **not** posted. The resolution is metadata on the root, not
   another line of chatter in a product whose thesis is less noise.

A resolved thread still opens on click, still appears in search, and never hides its
parent message. Reopening is the same control, inverted.

### 4.4. The open-questions view

Reached from the palette (`Cmd+K` → "Open questions") or the workspace header. It lists
unresolved root messages that have at least one reply, workspace-wide, newest first, grouped by
channel — backed by `idx_messages_unresolved`.

Opened from a channel's header it is **narrowed to that channel** (`?in=`): only its questions, its
count on the tab, Feed back to it, and *Show every channel* to widen it again.

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
| `@` and a letter | Member autocomplete: who a mention here would reach, found by display name or handle without case or accents; `↑` `↓` move, `Enter` or `Tab` writes `@handle`, `Esc` closes it, and `Enter` while it is open never sends (D-110 §8). **`@here` and `@channel` are not offered and are rejected on send** (D-12) |

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
- **The feed reads the feed, not the threads** (D-147). Reading the channel to the bottom reads what
  the feed shows; an answer in a thread keeps waiting — on the badge, in the tab title, in the inbox —
  until its thread is open in the panel with the page in front of the person, which reads its replies
  up to the newest one the panel has. A reply that arrives after that is still waiting.
- **A link to a message opens the channel at it** (`?message=`, D-149) — from Copy link, search,
  saved items and **Go to message** in the pins panel. The feed is read **around** the message, not
  from the newest page: it is brought into view in the middle, marked in the highlight tone for a
  moment (a fade that reduced motion skips), and focused, as ↑ ↓ would focus it; a reply opens its
  thread, where the reply is brought into view, marked and focused instead. Scrolling up reads older
  history as always; scrolling down reads newer history in below **without moving the reader** and
  without the "new messages" pill, since none of it is new. Until the window reaches the newest
  message, **Jump to recent** sits where the pill would, takes the reader to the bottom (not back to
  the unread marker), and so does sending. Nothing is marked read from a window short of the
  present. A message deleted, never there, or not the person's to see is said in one sentence over
  the channel — *That message no longer exists, or you can't see it.* — and the channel opens as it
  is.

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
| `Cmd/Ctrl+,` | Settings (D-146) |
| `Esc` | Close the topmost thing — palette, then edit, then the thread, files, pins or incident panel (focus returns to its root, or to the control that opened the panel) |
| `↑` `↓` | Move message focus |
| `T` | Open the focused message's thread in the panel, and move focus there |
| `R` | Reply to the focused message |
| `E` | Edit (own messages) |
| `Cmd/Ctrl+Shift+R` | Resolve / reopen the focused thread — on its root, or anywhere in its panel |
| `Alt+↑` `Alt+↓` | Previous / next unread channel |
| `Cmd/Ctrl+Shift+D` | Toggle Deep Work — on for an hour; another while is the account menu's or the palette's |

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
| Incident (panel) | "No incident" — declare one when something here is on fire; when the last was resolved | Skeleton, in the panel; the banner draws nothing until it knows | Retry in the panel; a timeline that fails says so with Retry, the controls still usable |
| Pins (panel) | "Nothing pinned yet" — pin a message everyone here should keep at hand | Skeleton rows, in the panel | Retry in the panel; a list that could not be brought up to date says so, with Retry |
| Channels to join (after an invitation) | "There are no public channels to join yet" + the way into the workspace | Skeleton rows | Retry; a join that fails part way names the channels and why, keeps them picked, focus on the button that tries again |
| Files (panel) | "No files yet" — what is shared here gathers in this list | Skeleton rows, in the panel | Retry in the panel; a further page that fails says so above **Load more**, and a list that could not be brought up to date says so, with Retry, keeping what it shows |
| Thread | n/a — never rendered empty; a link to a root the channel does not hold says so in the panel | Skeleton under the root, in the panel | Retry in the panel, root intact; a root that could not be read back, Retry in its place |
| Invitation | n/a — a link always names a workspace or says it does not open | Skeleton card | "This invitation does not open" + the way home; any other failure, Retry |
| Sign-in | n/a — always GitHub's button; the email form under it only where the server sends mail, and not until it has said so (D-138) | n/a for GitHub; the email form's button is busy while it asks | One sentence per reason a sign-in came back unfinished (`API.md` §2): what happened, then what to do, above the same button (D-121). The email form: the same sentence whatever the address once asked, a refused address under the field, "switched off" or the failure above its button |
| Sign-in link | n/a — a link always names its address or says it does not open | Skeleton card | "Not complete" for a fragment that is not a link, "used or expired" for one that does not open — each with the way back to sign-in; any other failure to show it, Retry; a failure to sign in, said above **Sign in**, which stays |
| How long history is kept (owner) | n/a — always a window, forever by default | Skeleton in the dialog | Retry in the dialog; a save refused is said above the buttons and the choice stays. A shorter window is said in full and its button is red and names what it deletes (D-139 §4) |
| Exporting the workspace (owner) | "You have not exported this workspace yet." | Skeleton in the dialog; one being made says so, and the list is read again until it is not | Retry in the dialog; one already being made is said, and the list read again; any other refusal above the buttons. A failed export says why by its code; a ready one is a link that works once; once followed it reads "Downloaded", says to export again if no file arrived, and the list is read again so what the server holds replaces the guess (D-140) |
| Erasing one's account | n/a — the dialog always says what goes and what stays | The button is busy while it asks | A username that is not theirs under the field; a session too old, with the way to sign in again; the workspaces they are the last owner of, by name; any other failure above the buttons. Done, the sign-in screen says the account was erased (D-139 §5) |
| Open invitation links | "No links are open" + **Make a link** | Skeleton rows | Retry |
| People (sidebar) | "Nobody else is here yet" under your own row + **Invite people…** for an owner or an admin | Skeleton rows | Retry |
| Channel details: members | "Nobody is in this channel. Anyone can join it." | Skeleton rows | Retry |
| Channel details: GitHub repositories | "No repository is connected…" above the Connect form | Skeleton row | Retry |
| Edit history | "No earlier versions: they were not kept, or were removed." | Skeleton row | Retry; older versions that fail to come are said below the ones shown |

**A screen that fails to draw** is replaced by "This screen stopped working" with **Reload** and
**Go home**; the rail and the sidebar stay, and going anywhere else draws afresh. A failure outside a
screen says "Purlay stopped working" with the same two ways out. Never a blank page (D-96).

**Unsent messages of a channel the person lost** — archived, left on another device, or their
membership ended, or gone from the channel list read after a time offline — are removed, and one
notice says how many were removed and why. Nothing could send them, and kept they would wait with
no screen to show them (#521).

**Connection loss** shows a single non-blocking bar: `Reconnecting…`. The composer stays
enabled — messages queue and send on reconnect (`ARCHITECTURE.md` §5.4). Disabling input on a
transient network blip is the failure mode this whole architecture exists to avoid. A send that
never reached the server is still `failed` after its three seconds (§3.1), with Retry and Delete, but
its words say it goes on its own when the connection is back — not to check the connection and try
again, which is what the product is about to do for the person (#685).

**Deep Work** shows a persistent, quiet indicator in the header with its expiry, and the account menu
says the minutes left. A mode you can forget you are in is a mode that loses you messages.

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
