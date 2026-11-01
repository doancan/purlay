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
   is set: prose gets a readable line, and the screen gets nothing else; a control is 32px tall, a
   comfortable target for the pointer (D-110, D-151).
3. **Keyboard first, mouse optional.** Every action reachable by mouse has a key. The command
   palette is the primary navigation surface, not a power-user extra.
4. **Never move content under the reader.** Late-arriving content, an opening thread and
   resolving images must not shift what someone is currently reading. (§6)
5. **State is always visible.** Sending, failed, unread, resolved, offline — each has a
   distinct, non-decorative visual. A message whose delivery state is ambiguous is a bug.

---

## 2. Layout

One fixed shell, flat: a rail and a sidebar in one tone that follows the theme — a light neutral in the light theme, the dark navy in the dark (D-180, which changes D-118), the dark theme layered dark greys with the navigation a step deeper than the conversation (D-206), and the indigo family as a theme of its own, Midnight (D-183, D-184) — the channel on the window's ground, and an
optional members column. No resizable panes in Phase 1 — a saved layout is one more state to sync
for no benefit at this size; what the person arranges about the sidebar is what it shows, not where things sit (D-195). Regions are separated by tone and one hairline, not by boxes (D-110).

```
 ┌────┬──────────────────┬────────────────────────────────────────────────┬─────────┐
 │    │                  │ # api  Backend API…     (Feed)(Questions 3) ⍟ │         │
 │ ▢  │ AE Acme Eng…   ⌄ │────────────────────────────────────────────────│ members │
 │    │ ⌕ Search… ⌘K     │ Today ──────────────────────────────           │ (opt.)  │
 │    │ Channels         │ (SC) Sarah Chen  09:14                         │         │
 │ ✉• │  # api           │      Here's the updated session hook…          │  200px  │
 │ ?3 │  # deploys    2  │      ┌ ts · 14 lines ──────────── Copy ┐       │         │
 │ ⌕  │ People           │      └─────────────────────────────────┘       │         │
 │    │  (SC) Sarah Chen │ ┌──────────────────────────────────────┐       │         │
 │    │ (DÖ) you       ⚙ │ └────────────────────────────────── ➤ ┘       │         │
 └────┴──────────────────┴────────────────────────────────────────────────┴─────────┘
```

- **Rail (56px)** — not the workspace, which heads the sidebar beside it (D-206); channels, the
  inbox (a dot while anything needs you — the same fact as the mention badges, D-106, so in Deep Work
  it is not drawn, as they are not, D-15), open
  questions (a neutral count: they are the team's, not a summons), search, and **saved** — the
  messages you kept to come back to, in three tabs, In progress, Archived and Completed — chosen
  above the list as the inbox's All and Unread are (D-158) — each moved or let go from its row
  (D-128) — and **drafts and sent** (D-215): what the person started and has not sent, on this device,
  each opening its composer, deleted with Undo, and what they sent, newest first. Every entry is a route
  or a menu that exists without the rail; it adds no destination. At its foot a gear opens
  **Settings** (D-146). Its top is an empty drag strip for the desktop shell (D-14).
- **Sidebar (264px)** — the workspace's card (D-209): its mark, its name and, under it, your role and how many
  are in it, framed, with a chevron — the one door to the **workspace menu** (the workspaces to switch to, as
  radios with their marks, the current one checked, **Create workspace…**, **Copy workspace link**, **Mark all
  channels read** with its key, `Shift+Esc` (D-238), and for an owner or an admin **Invite people…** and
  **Workspace settings**, D-146), and beside it **Sidebar options** — how the person arranges the column (D-195, below) — the jump
  field (the palette's door, `⌘K`), **All unreads** while a channel waits (D-216: each unread, unmuted channel's
  new messages oldest first, a page each, Mark read reading what was shown, replies said to wait in their
  threads), the **starred** channels — a section of their own above the
  rest, by name, there only once one is starred, from **Star this channel** in a channel's header
  (D-132) — the channels, by name so that a new message never moves a row (D-160), under a heading that carries **Browse channels** and **New channel**, always
shown in the section's quiet tone with a tooltip each, never revealed only under a pointer — the **conversations** — groups of up to ten
  people, each named by its people, and **New message** (`+`), which picks people ("To: …") and
  starts the conversation of exactly them (D-127) —
  each drawn with the faces of its first two people, the second overlapping the first, and "+N"
  for the rest, in the height of any row (D-167) —
  then the people, and your own row at the foot — your avatar with your online dot, the name over the
  handle, and the up-and-down chevron — which opens the **account menu** (D-124, D-146, D-207): who
  you are, as a card; **Deep Work ▸**, a submenu of whiles — 30 minutes, an hour, two hours or until
  tomorrow — or, while it is on, until when, the minutes left and its end, in the menu itself; **Settings** (`Cmd/Ctrl+,`); the shortcut reference;
  and **Sign out**. Unread channels are bold, and one set to tell nothing carries a struck-through bell after its name, said as *muted* (D-107);
  unread **mentions** carry a count badge. Nothing else gets a badge; a channel with an incident open
  carries its severity after the name, **SEV1** to **SEV4** — a state, not a count — said with its status
  to a screen reader (D-137). A person has an avatar, and a
  dot in its corner while they have Purlay open (D-136), said as "online" beside the name to a screen
  reader. Offline and not known are the same: no dot — a presence that failed to load draws nothing,
  never a team gone offline.
- **Sidebar options and folding** (D-195) — the column is the person's to arrange, by **what is shown**, never by how
  tightly (D-118 §6). Each section's heading is a button that folds it; a folded section keeps listed what is unread,
  what mentions the person, a channel with an incident open and the open row, so a fold never hides what is waiting or
  what is on fire. **Sidebar options** (a menu beside
  the workspace's name) holds: *Show* — everything or only what is unread (and the open row); *Sort channels* — by name
  (the default, a place stays put, D-160) or by what was written in them last; *Sections* — Conversations and People may
  be switched off (and are still drawn for the conversation the person is in, until they leave it), Channels may not; *Hide muted channels* — a muted channel goes unless it mentions the person, has an
  incident open or is the open one, and a starred channel stays (conversations and people are never left out for being
  muted); **Reset sidebar**, offered only while something is changed. The button is filled
  while anything is changed, and its name says *changed*. A list emptied by these says *Nothing unread.* or *Nothing to show
  with these options.* in the section's quiet tone, never as an error. Kept in the browser, per person and workspace; a
  browser that refuses storage still arranges the column while the page is open.
- **Browse channels** — the public channels the person has not joined, by name (D-160), each saying
  what it is before it is joined: its name, and on one quiet line how many people are in it (*12
  members*) and its topic, cut with an ellipsis; **Join** on the row joins and goes there. Past eight
  channels a **Find a channel** field narrows them by name and topic; it is empty each time the dialog
  opens (D-167).
- **A row's context menu** (D-165) — a right click on a channel, a person's conversation or a group,
  Shift+F10 or the ContextMenu key on a focused row, or a finger held on it, opens what can be done to
  it without opening it, and only what applies and the person may do: **Mark as read** while it is
  unread (the feed, as reaching its bottom reads it — a reply waiting in a thread still waits, D-147);
  **Star** or **Unstar**, a channel's; the notification level's three choices; **Copy link**;
  **Channel details…**, or **Conversation details…** for a group; and **Leave channel…** for a channel,
  never a conversation, asked first in a dialog that says what it costs. Each is painted at once and put
  back with a toast when refused, as in the header. Escape gives focus back to the row.
- **Channel** — header, feed, composer, in that order, one column. The header names the channel and
  carries the two views as a segmented control: the feed, and **open questions** with the live count
  of *this channel's* — never the workspace's, which is the rail's and the sidebar's — opening the view
  narrowed to the channel (§4.4). In a channel it is always there, being the product's argument; a
  conversation (a direct message or a group) carries it only while it has open questions, since an
  empty view there is one more control. The name is cut with an ellipsis before anything is drawn
  over it, and the topic gives way before the name. The channel's **name opens its
  details** (and so does the topic, for a pointer) — see *Channel details* below.
- **Feed** — the single column: the whole width beside the sidebar, its rows from the left edge as
  Slack's are, never centred with empty margins (D-175, D-177).
  Max width 1040px bounds only an empty state's sentence or a card drawn inside it.
- **Member list** — collapsed by default. Presence is decoration, not information.
- **Thread panel (440px)** — on the right of the channel, only while a thread is open (§4, D-122).
  The feed keeps the rest of the width.
- **Files panel** — the same place, opened by the header's **Files** control (D-129): every file
  shared in the channel, newest first, each with who shared it, when and its size. An image shows its
  thumbnail and opens the image viewer, whose ←/→ step through the panel's images (D-159); any other
  file downloads; a file said in a thread opens that thread in the
  panel's place. One panel at a time: opening the files closes a thread, and a thread opening closes
  the files. Opening moves focus to the panel's heading; closing puts it back on the Files control.
- The header's **bell** is drawn by the channel's level — ringing for every message, plain for mentions and
  replies, struck through for nothing — so the level shows without opening its menu (D-107).
- **The star** is beside a channel's name, where Slack and Linear keep it; on the right are the panels the
  header opens (Files, Pinned messages, the incident), then, set apart by a hairline, the bell and Add people.
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
  direct message, the screen's name, or a page of Settings as `Members · Settings`. While anything needs the person it starts with the same count
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

**The inbox** (D-106, D-153, D-162, D-208). What the person was told in this workspace, newest first, in one
full-width column like the feed — the shape the open questions, search and saved share (D-158): a
**category** — **All**, **Mentions**, **Direct**, **Threads** (replies and resolutions) — in the address
(`?category=`), and **All** or **Unread** beside it, both asked of the server, so what waits is
found however old — then **Today** and **Earlier**, each a card of rows. A row says who, why and where,
with the message under it in two lines at most; unread is a dot at its edge and the line in full ink,
read is muted. Opening a row takes the person to the message and reads it; **Mark read**, beside the
row on a pointer's hover or a keyboard's focus, reads it without going; **Mark all read** in the header
reads what is on screen. A row read in the Unread view stays there, muted, until the person looks again,
so nothing moves out from under the pointer. Unread with nothing waiting says *All caught up*.
A reply names its thread by the root's first line — *In “…”* — and says whose thread it is: *replied in
your thread* when the person started it, *replied in a thread you're in* when they only replied in it.
**One thread's replies of one day are one row** (D-162), where the newest of them sits: *3 new replies
in “…”*, the newest replier's avatar, who replied (*Alice, Bob and 1 other*), the newest one's time and
words, unread while any of them is. Opening it, or its **Mark read**, reads every reply it gathers.

**The inbox panel** (D-208). On a wide window the rail's Inbox opens a panel beside it rather than the
page: the inbox's title and **Mark all read**, the four categories, the newest ten of the one chosen in
rows a line shorter than the page's — the message in one line, **Mark read** as an icon — and **See all**
at its foot, which opens the page on the same category. Opening a row reads it, closes the panel and goes
to the message; the panel remembers its category while closed. It carries no count of its own (D-110).
In a category, **Mark all read** reads the rows shown — "up to the newest" is the whole inbox's, and would
read what the other categories hold. Below the narrow breakpoint the rail's Inbox is the link to the page.

**Invitations** (D-115). An invitation is an address, `/invite#…`, that somebody pastes into the
chat the team already uses.
- **Opening one** shows a card like the sign-in screen's: the workspace's name, until when the link
  opens, and **Join**. A person already in it is offered **Open** instead. Joined, they are offered
  the workspace's public channels to join (in a new workspace, the `#general` it starts with, D-174),
  the three busiest marked **Active** and picked, joined together in one press or skipped; a join that fails part way names the channels it could not join
  and keeps them picked (D-132). A person not signed in
  signs in first and comes back to the same card. The token leaves the address bar as the page loads,
  so it is not left in the history or a screenshot. A link that does not open says so in one
  sentence — expired, revoked, or never real look the same — and offers the way home.
  A person who is **not signed in** is not bounced to sign-in: the page says *You have been invited* (the
  workspace's name is read only with a session, so it is not shown yet) and offers GitHub and, where the
  server sends mail, an email field with **Email me a sign-in link**, and under them *Already have an
  account? **Sign in with your password*** (a link to sign-in; the invitation stays in the tab and the front
  door brings the person back to it). Before the page leaves for GitHub, or asks for the link, it asks the
  server for the invitation's **passport** (`POST /api/invitations/passport`, R51; D-179 §5) — the answer
  sets the cookie GitHub's callback will present, or records the address a link may make an account for —
  and only when it is given does anything else happen. A link that does not open is the page's *does not
  open* state; too many askings are *This invitation is being opened a lot right now. Try again in a
  while.*; any other failure is said in words and nothing else happens. Signed in, the page skips the
  passport and joins as above.
- **Making one** is an owner's or an admin's: **Invite people…** in the workspace menu opens a dialog
  with **Make a link**, the link once made with **Copy**, and a way to the links still open — who made
  each and until when, each with **Revoke** — on the Invitations page. A member does not see the entry.
- **By email** (D-179 §5), only where the server can send mail (the same answer the sign-in screen
  reads, `GET /api/auth/methods`; without it, or until it has answered, the dialog is exactly the above).
  An **Email addresses** field above the link takes addresses as chips: Enter or a comma, or a paste of
  several, makes each a chip; × or Backspace on an empty field removes one; an address typed again, in any
  case, is one chip, and at most twenty are taken. A chip that is not an address stays, red with a glyph
  and the words *not an email address* — never colour alone — and is not sent. **Send invitations**
  (*Send 3 invitations*) makes one link and sends the addresses it, as members: there is **no role** to
  choose and no address is tied to the link. The link is shown whatever happens, so a message that
  fails is not a dead end.
  **What the screen says is what the server did, no more.** The letters are handed to the mail server
  after the answer, so the answer is *queued* and the words are *"Asked the mail server to send the
  invitation to 3 people"* with *"It is not confirmed that it arrived. If a message does not, the link
  below works too."* — never *sent* or *delivered*. Each refusal is its own sentence naming the addresses
  and the reason: not an email address; *you have reached today's limit of 50 invitation emails*;
  *this workspace has reached today's limit of 200 invitation emails*; *this server cannot send email*.
  The addresses refused stay in the field, so nothing leaves unsaid; the ones queued are cleared. A
  request that fails says *Could not send the invitations* above the link, keeps the addresses and
  claims nothing. The letter is plain text in the interface's language: who invited (their display
  name), the workspace, the link with its token after `#`, until when it works, and that it can be
  ignored if unexpected; its subject is fixed text, and the names in it are cut, stripped of line breaks
  and of anything that reads as a web address.

**Members** (`ARCHITECTURE.md` §7.4). **Members…** in the same menu lists everyone in the workspace
with a role each: a labelled select where the person may change it, the role in words where they may
not — an admin does not touch an owner or make one. A person's own role is theirs to change (D-111): an
owner steps down once there is another, an admin becomes a member; the row asks first, because only
somebody else can change it back. **Remove** is on everyone's row but one's own — that is leaving
(Sessions & account) — and asks in the row first, because it costs the person every channel. The last
owner is said as such.

**The audit log** (D-26). **Audit log…** in the same menu, an owner's or an admin's, reads the trail
newest first, a page at a time: each entry a sentence — *Doğancan changed Alice's role from Member to
Admin* — and when. An action newer than the client is said by its name, never dropped.
Above it, a card narrows it (D-222): **Person** (Anyone, or one of the workspace's people, as search's
picker), **Action** (Any action, or one in words), **From** and **To** — days in the reader's own zone,
both included, the last one refused on its field when it comes before the first, and nothing asked
until it is put right. Each choice is the page's address, so Back undoes it and a reload or a shared
link keeps it; **Clear filters** appears once something narrows. Narrowed to nothing it says *No entry
matches these filters*, not that nothing has happened. The card's foot downloads what the filter keeps —
all of it, not only what is shown — as **CSV** or **NDJSON**, links the browser saves; the download is on
the log itself. Two by two on a wide window; one under another, full width, on a narrow one.

**Channel details** (D-123, D-154). Clicking a channel's name in its header opens a wide dialog
(`size-dialog-lg`; on a narrow window a sheet that fills the screen) with three tabs, **About** chosen on
opening — one tab in the Tab order, ← → between them, Home and End to the ends, Escape closes. The
dialog opens with focus on itself, never on the name, so a key pressed on opening renames nothing; no
dialog opens with a field's text selected. **About**: the **name and topic**, editable by a member of
the channel with **Save** (somebody who has not joined reads them and is told to join); the
**notification level** as three choices, the current one said in words (the header's menu, painted
first and put back on a refusal); for an owner only, **History** (D-225): the workspace's window and
what this channel keeps, each in a sentence ("The workspace keeps history for 30 days. This channel keeps
its messages and files for 1 year."), and *Keep this channel's history* — *As long as the workspace*,
the windows longer than the workspace's, and *Forever*; never a shorter one. A choice that keeps less
than now says, before it is saved, what the next night deletes, and its button says it again in red; a
refusal because the workspace now keeps longer is said in those words, and the setting is read again;
and at the foot a **Danger zone** in the danger tone — **Leave
channel** for a member and **Archive channel** for an owner or an admin, each row saying what it costs.
Each of the two asks in place first; done, the person is taken to the workspace and told in a toast.
The last member of a private channel is told to bring somebody in first or ask an admin to archive it.
**Members**, its count in the tab: who is in it, a field to find one by name once there are more than
eight, and **Add people** (the same dialog as the header's: the workspace's people, narrowed as typed,
those who can be added first with **Add**, and anybody already in the channel after them, saying
*Member* quietly with nothing to press, and a sentence above them when that is everybody), and
**Remove** on each row the person may take out (D-172) — never their own (that is Leave): an owner any
row, an admin any but an owner's, a member of a private channel another member's, and nobody's in a
public channel for a member. It asks in the row first — the question says, for a public channel, that
their messages stay and they can join again, and for a private one that they stop seeing it — and on
yes the row goes at once; a refusal puts it back and is said under the list. The person removed, if
they are reading the channel, is told *You were removed from this channel* in its place (a private
one) or sees it as one not joined (a public one), and their sidebar loses it at once.
**Integrations**, for an owner or an admin only — nobody else has the tab: the **GitHub repositories**
the channel hears from (D-134) — each with what it posts, its last delivery and why it last failed,
**Disconnect** asking in place, and a form to **Connect** one, which answers with the payload URL, the
content type and the secret, each with Copy, the secret said to be shown only now, until **Done**. A
half-typed name survives a look at another tab. A direct message between two has no details: its title is not a button. A group's title opens its
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

**Another workspace** (D-124). **Create workspace…** in the same menu — offered only to a person this
server lets make one (`WORKSPACE_CREATORS`, D-155) — opens the form `/` shows a person with none — a name and an address — and goes to the new workspace, with Back to where
they were. **A new workspace starts with `#general`** (D-174), its maker in it, and that is where the
form leaves them — from `/` or from the menu — never on the welcome step, which is an invited person's.

**Settings** (D-146). A page, `/w/<slug>/settings/<section>`, opened from the rail's gear, the
account menu, the workspace menu's **Workspace settings** and the palette. The sidebar's place holds
its navigation: **Back to <workspace>**, then **Account** — Profile, Preferences, Notifications,
Keyboard shortcuts, Sessions & account — and, for an owner or an admin, **Workspace** — General,
Members, Invitations, Integrations, Audit log, Data & retention. The current page is marked as the
current channel is. Each page: a title, one sentence, then cards; a setting is a row with its label and
a sentence on the left and its control on the right (stacked below 900px). The page is the main area's full width, from its left edge (D-177). A choice
applies when it is made; a form of words has **Save** in its card, enabled once something changed, its outcome said beside
it. On a narrow window the navigation opens as the sidebar does.

- **Profile** — what *Your profile…* held: title, status line, time zone with this device's one press away; and
  the **Name**, with its own Save, where it is the person's — an account GitHub made shows GitHub's (D-235).
- **Preferences** — the theme (System, Light, Dark) and the language, each a set of choices shown at once.
- **Notifications** — Deep Work (start, or until when and end), notifications on this device (D-126,
  D-148) — one switch for the open tab's notices and, where the server has push, the closed tab's — with
  where a blocked browser undoes it, and what interrupts in Phase 1 in words (D-12, D-29, D-107).
  While on, **Test notification** requests a notice on this device. Its outcome says the browser
  accepted the request, not that the operating system displayed it; a refusal explains where to check
  permission and device settings. It does not send a chat message or change the channel preferences.
  Then **Quiet hours** (D-234): off, or a start and an end — one earlier than the start runs past midnight, and
  says so — and the days a window starts on, named in the reader's language, read on the clock of the profile's
  time zone, which the card names; with no time zone on the profile it says so and leads to Profile.
  **Email** (D-240), only where the server can send mail and the person's address is verified: one check box,
  *Email me about direct messages and mentions I haven't read*, off until checked, applied when it is checked,
  with a sentence saying when a letter goes (fifteen minutes unread, never in Deep Work or quiet hours, at most
  one an hour). The letter ends with a link to `/mail/stop#…`, a page of its own that needs no sign-in: it asks
  *Stop these emails?* and stops them only on its button, so a mail scanner that opens it changes nothing.
- **Keyboard shortcuts** — the reference, as a page.
- **Sessions & account** — a **Create issues as you** card (D-246) only where the server has a GitHub App:
  off until the person chooses, *Not allowed. Purlay writes nothing to GitHub as you.*, with **Let Purlay create
  issues as me** — GitHub's authorization screen, coming back to this page with the outcome in one line — and, once
  allowed, *Allowed, as `login`* with **Stop allowing**. Never asked at sign-in. Also first *How you sign in* (D-176, amended by D-179): the address and whether a
  link sent to it signs in, and, only when GitHub is linked, a GitHub row with the login — read only,
  nothing to press. There is no **Connect GitHub**: one verified address is one account (D-179 §5), so a
  person who signs in with GitHub on an address they verified by link arrives in the account they have.
  Next, **Password** — only for an account that has one (`hasPassword`: the administrator the setup made):
  *Current password* and *New password*, with the policy's rules shown as met, broken or not yet known as
  the new one is typed (the same `passwordProblem` the server runs, §11), and **Change password**. A
  success says *Your other sessions were signed out.* and keeps this one — the page stays on Settings, the session is the same row; if signing the others out failed after the password changed, it says so and points to *Sign out everywhere*; a wrong current password is one
  sentence, a refused new one is named by rule, and a wait is told in minutes.
  Then **Two-step verification** (D-236), for an account with a password only — other ways in say their
  provider keeps them: off, *Turn on* asks for the password, then shows the key as a QR code, as text and as
  an `otpauth://` link, and is on only after a right code from the app; the ten backup codes are shown once,
  with **Copy**. On, *New backup codes* and *Turn off* each ask for the password — where the server requires it
  (D-239), there is no *Turn off*, and the card says the server requires it. At sign-in, after a right
  password, the form asks for the app's code, or a backup code instead; a wrong code is one sentence, a spent
  or expired step says to start over, and a lock says for how long.
  Next, *Where you are signed in* (D-193): each live session, the one used last first — a Mac by the name it
  sent (*Purlay for Mac* without one), any browser as *Web browser*, each with when it was signed in and, but
  for this one, when it was last active. This one is marked *This device* and has no button; every other has
  **Sign out**, which asks nothing, takes the row off at once and says it was signed out, or puts it back and
  says why when refused; one already ended elsewhere stays gone, unsaid.
  Next, **Your data** (D-241): what an export of the person's own data holds, in a sentence — their account,
  the workspaces they are in, every message they wrote that stands, their reactions, saved items and files,
  and nobody else's words — **Export my data**, and their exports, newest first, as an owner's export lists
  them: being made, a link that works once, downloaded, expired, failed by its reason.
  Then *Sign out everywhere…*, *Leave <workspace>…* (D-152; the last owner is told
  to make somebody else an owner first) and *Erase my account…*, each asking first.
- **General** — the workspace's name, its address (which stays), the **archived channels** (D-232) — each with
  when it was archived, a private one only to its members, and **Restore**; a name taken since says to rename the
  other first — and *Create workspace…*.
- **Members** — a table: person, role, and actions, with a search field and a role filter above it;
  the rules of *Members* below hold unchanged.
- **Invitations** — making a link and the links still open, as *Invitations* below says.
- **Integrations** — the GitHub connection, as below; and, only where the server has a GitHub App (D-246), a
  **GitHub issues** card: *Not connected* or *Installed on acme since …* (*Suspended* when GitHub says so, with a
  sentence that nothing is written to it), **Connect on GitHub** (or **Connect again**) — a full navigation to
  GitHub's own screen, where the repositories are chosen — and **Disconnect**. How the trip ended is one line in
  the card from `?github=` (*connected*, *expired*, *refused*, *not an installation you own*, *GitHub could not
  be reached*). Not drawn where there is no App: nothing of issues exists then.
- **Audit log** — the trail as a table, newest first, a page at a time, narrowed by person, action and days,
  and downloaded as CSV or NDJSON (D-222).
- **Data & retention** — the workspace's **storage**: a meter with what is used and the quota in words
  ("1.2 GB of 5 GB") and what is left, in the warning tone from nine tenths and the danger tone, with a
  sentence, once full; the quota is the server operator's to set and the card says so, with nothing to
  change it (D-173) — then how long history is kept, with how many channels keep theirs longer, when
  any do (D-225), and exports.

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
      ○ Open · 4 replies · last 12m ago  Show thread T

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
- **A code reference is a link into the channel's repository** (D-223) when the channel has exactly one
  GitHub feed: a path with a source extension — `src/retry.ts:14`, `apps/api/src/x.ts#L10-L20`, the
  compiler's `src/x.ts(14,5)` — opens the file at that line on the default branch, a bare file name in
  inline code (`` `retry.test.ts` ``) searches the repository for it, and a commit's SHA (7–40 hex, a
  letter and a digit) opens the commit. In prose and inline code only, never in a fenced block, which is
  code to read and copy. Drawn as any link is — underlined, so not by colour alone, opening in a new tab
  and saying so to a screen reader, a stop for the keyboard. No feed, or several, and nothing is linked
  that the words did not link.
- **A link to a picture is the picture, under the words** — up to three, in the order written, each a
  link to the original, drawn through the API's proxy so the picture's host never sees who is reading
  (#110). One the proxy cannot show draws nothing; the link stays a link.
- **A file sent with the message is under the words** (D-109 §6): an image as its thumbnail, in a box
  shaped like it and kept before it loads; any other file as its name, its size and a download — and a
  text file up to 512 kB (a CSV, Markdown, code by its extension) **Preview** beside it, read only when asked
  and kept: a CSV's first fifty rows as a table and how many more, Markdown formatted, code coloured in its
  language, in a box that scrolls, through the same renderer as a message (D-210). An
  image opens the **image viewer** (D-159): the picture over the whole window on the navigation's dark
  tone, fitted to it and never enlarged, with its name, who shared it, its size and when, **Download**,
  **Open original** in a new tab, and Close. Esc — whatever is focused —, the close button or a click
  beside the picture close it, and focus goes back to the thumbnail; `←` `→` step through the message's
  pictures and stop at either end. While the picture loads its thumbnail stands in its place; one that
  does not load says so, with Retry. ⌘/Ctrl-click still opens the image in a tab.
- **One edge, no bubbles** (D-187, which reverses D-119 and returns to D-100's flat rows). Every message — yours included — hangs from the left of
  the feed, with an avatar in a fixed column and the author's name over the first message of a group, the way
  Slack draws it. There is no bubble and no tint: the words sit on the page, so a code block, a table or a quote
  has the whole column — a heading is sized by its level (D-189) and a fenced block is coloured by its language (D-188) — and a ` ```diff ` block is drawn as a diff — numbered lines, added and removed in
  colour and in words, **Unified** or **Split** on a wide window (D-133). The channel's feed and composer are one
  column, the main area's full width (D-177). Direct messages are the same rows: a conversation with one other
  person is not drawn differently from a channel.
- **A person is named by their name** — the display name, as the sidebar names them — wherever they
  are named in words: the feed, a direct message's header, the inbox, search, the open questions,
  *Resolved by …*, and what a screen reader hears of a row. The handle appears only where it is the
  point: an `@mention`, the profile's handle line, and beside the name where people are picked.
- **The header line** is over a group's first message: the name, then the time in the mono face.
- **Consecutive messages** from the same author within 5 minutes hide the avatar and the header;
  their time shows on hover, in the avatar's column.
  The avatar belongs to the group's first message, so a message arriving below never changes one above.
- **Hover controls** are one floating bar — hairline edge, the float shadow — on the row's own top
  edge, in its right corner (D-150, amending D-119 §6; D-187 puts every message on the left, so the
  corner is the same for all). It never reaches above its row, so it never covers the row above or
  the name over a message; it never reflows the row, and the row itself is not tinted. **One bar on
  the page**, across the feed and the thread panel: the row under the pointer, or the focused row
  while the keyboard is in use; a row whose menu is open keeps its bar. A thread's root, drawn in the
  feed and at the top of the open panel, is two rows: only the copy under the pointer shows it. On a
  phone the row tapped is the one.
- **A message's controls are reached from its row** (D-168): the list is one Tab stop, and Tab from
  the focused row walks that row's links, blocks, files, cards, chips and bar before leaving the list
  (§7). Every control stays clickable and readable on every row.
- **The bar holds** React · Reply (a thread's root) · Save · Pin · More, each the same square
  control on every window, each with its tooltip and its key where it has one (Reply `R`). **More
  is on every message**: Copy text, Save and Pin again, then Edit (`E`) and Delete on your own; an
  owner or an admin may delete anybody's, told it goes on the audit trail. React opens the quick
  set as one row of tiles, the name of the one reached under it and yours marked as chosen, opening
  upward and kept inside the feed so it never covers the composer.
- **A message that mentions you** fills your own `@name` in the text, and says so to a screen reader;
  the message has no edge (D-119 §5, amended). A **quotation** is a recessed block with a quote glyph,
  never an edge, so the two cannot be mistaken for each other.
- **Timestamps** are relative under an hour, then `HH:mm`, then `MMM D`. Absolute time on hover.
- **Reactions** sit below the content, above the thread affordance, as soft pills (D-209): no frame,
  the accent's tint under the pointer, yours in it and heavier. A chip's tooltip says who:
  "You, Alice and Bob reacted with 👍"; past three, two names and how many others (D-150).
- **Edited** and **Pinned** share one line under the words, apart from each other.
- **Save for later** sits beside React on any message the person can read (D-128): marked at once,
  put back and said with Retry if the server refuses; a saved message's mark is filled.
- **The day** is a label at the column's left edge with a rule after it. (D-110)
- **Copy link** is first in every message's **More** menu (D-149, D-150): the
  message's whole address on the clipboard, said with *Link copied*, or, when the browser refuses,
  that it could not be copied.

### 3.1. Delivery state

| State | Appearance | Behaviour |
|---|---|---|
| `sending` | Full opacity, subtle clock glyph beside the time | Paints in < 16ms, before any network call (`PRD.md` §5) |
| `sent` | Glyph removed | On `ACK`. **The row does not move** — the id was final from the start (D-8) |
| `failed` | The message's left edge in the error colour, "Retry · Delete" inline | After 3s with no ACK. Never disappears silently |

**Writing is a member's** (D-156). A public channel the person has not joined is read with a bar in
place of the composer — *You are reading #name without being a member* and **Join** — and a send that
was already on its way when they left, or that reached the server some other way, is `failed` with
the reason in words: they are not in the channel, and joining it is how to write there; Retry then
sends it. Reacting, editing and resolving there are refused the same way, said as a toast.

The `sending` state is deliberately **not** dimmed to 50% opacity. Dimming implies "not real
yet"; in an optimistic UI the message *is* real, and flickering opacity on every send is visual
noise on the most frequent action in the product.

---

## 4. Threads — the wedge

### 4.1. In the feed

A root message with replies shows one line beneath it:

```
  ○ Open · 4 replies · last 12m ago  Show thread T
```

Clicking it, or pressing `T` on the focused message, opens the thread **in the panel** on the
right (D-122). The affordance is absent when there are no replies — an empty thread control on
every message is clutter that teaches people to ignore that region. While a root's thread is in
the panel, its line is filled and says **Thread open**, so the eye finds where the panel came from. The line is as
wide as what it says, under the message's words and from their left edge (D-177, D-187) — never the
status a column away from the message it is about.

### 4.2. The panel

```
  ┌ Thread · #api ────────────────── [Follow] × ┐
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

- **Bookmarks** sit in a row under a channel's header (D-218): the links its members keep at hand, each
  opening in a new tab. A member adds one with **Add a bookmark** — an address (a bare domain is read as
  `https://`) and a name, the site's own if left empty — and removes one with × on its chip, with **Undo** in
  the toast. Someone who can see the channel but is not in it reads the row and changes nothing; with
  nothing to read, they see no row at all.
- **Forward…** is in a message's **More** menu for a member (D-217): choose a channel or a conversation you
  are in, by name, add a note if you want, and it is sent there as your message ending in the original's
  link. **A link to a message of this workspace is drawn as a card** under the words — who, where, when and the
  start of it — for whoever may see the original, and as *This message is not available to you* for whoever
  may not: forwarding a private message shares a link, never its words.
- **Quote reply** is in a message's **More** menu for a member (D-213): the part of the message the person
  selected, or all of it, goes into the composer it answers in — a reply's thread, a root's channel — as a
  markdown quote with its author's name (never an `@`, so quoting does not notify) and a link back, after
  what was already written, the caret under it, focused. A message over a thousand characters is quoted
  to its start.
- **Mark unread from here** is in a message's **More** menu for a member (D-212): the channel's read
  position moves back to just before it (a reply marks its thread's root), the sidebar and the badge show
  it at once, and the channel the person is looking at is not read again by being looked at — not at the
  bottom, not when a new message arrives, not on leaving — until it is opened again. Refused, a toast
  says so and the channel reads as before.
- **One thread at a time.** Opening another replaces it. A channel opened again opens with no
  thread, unless its address names one (`?thread=`, from the open questions and the inbox), which
  opens even when its root is older than the feed's first page — or a reply's link does (§6).
- **The header** names it — *Thread · #channel*, or the person's name in a conversation — and its
  close control (`Esc`) closes it. Beside the close control, **Follow** (D-161): a toggle with one
  name, pressed while the person is told of new replies — a bell — and not pressed with the struck
  bell a muted channel shows; its tooltip says what pressing it would do, *Get notified about new
  replies* or *Turn off notifications for replies*. Somebody who started or answered the thread
  follows it until they press it; replying again does not follow a thread let go again. It paints at
  once and a refusal puts it back with a toast, and Retry when trying again could help. Until the
  state is read it is there and disabled, so the header does not move; when it could not be read,
  its tooltip says so and pressing it reads it again. A mention in the thread still arrives.
- **The root**, its status and **Resolve / Reopen**, a rule labelled *N replies*, then the replies as
  the feed draws them: one edge, grouped by the same rule (§3). The reply box is at the bottom, and
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

Plain textarea, GFM, no WYSIWYG (`PRD.md` §4.1). **A formatting row above the text** has a button for every
construct the renderer draws — bold, italic, strike, link, bulleted list, numbered list, quote, inline code,
code block, table (two columns and a row to fill in, its first heading selected, D-210) — and a preview toggle
at its end; under the text sit the mention, an emoji picker and the file
attach. Each button only *inserts markdown* that the keys below also produce (D-110, D-181). **A thread's
box has the same row** (D-164, D-181): in the panel's width the key hints are not drawn (a screen reader
still reads them) and Send is the icon alone.

The **emoji picker** is a grid of four groups (faces, hands and people, work, symbols), arrow keys move
through it, `Enter` writes the emoji where the caret is and the focus goes back to the box; `Esc` closes it
with nothing written. The **preview** draws the draft as the message will be drawn; the text is still there
under it, and Send works while it is open (D-181).

| Key | Action |
|---|---|
| `Enter` | Send — except inside a code fence that is still open, where it is a newline (D-188) |
| `Cmd/Ctrl+Enter` | Send, wherever the caret is (on a phone `Enter` is a new line and the Send button sends); the hint under the box names it while the caret is inside a fence (D-188) |
| `Shift+Enter` | Newline; in a list or a quote it carries the list on, and an empty item ends it (D-181) |
| `Cmd/Ctrl+B` `I` `E` | Bold, italic, inline code |
| `Cmd/Ctrl+Shift+X` `U` `7` `8` `9` `P` | Strike, link, numbered list, bulleted list, quote, preview (D-181) |
| ` ``` ` then `Enter` | Opens a code block; see `Enter` above |
| `Cmd/Ctrl+Alt+Shift+C` | A code block round the selection, or an empty one (D-188). Not on AltGr layouts that type a letter there |
| a backtick over a selection | Wraps it in inline code instead of replacing it (D-188) |
| `↑` on an empty composer | Edit your last message |
| `Esc` | Cancel edit / close the thread panel / close palette |
| `@` and a letter | Member autocomplete: who a mention here would reach, found by display name or handle without case or accents; `↑` `↓` move, `Enter` or `Tab` writes `@handle`, `Esc` closes it, and `Enter` while it is open never sends (D-110 §8). **`@here` and `@channel` are not offered and are rejected on send** (D-12) |

The editor of a sent message takes the composer's Enter, Shift+Enter and formatting keys, and the same
IME and phone rules; it has no preview, no `↑` and no `@` list (D-188).

Pasting an image uploads immediately and inserts a placeholder; the message can be sent while
the upload is still in flight, and it goes when the files land **even if the person has moved to another
channel or closed the thread** (D-171): the files and the waiting send belong to the place, not to the box
on the screen, and are there when the person goes back. If a file fails meanwhile the send is held, a
toast says where it was not sent, and the words and files wait there with the reason. **A file that did not upload says why under its name** (D-159), in
words from what the server answered: larger than the limit, an image past the side or pixel bound, an
image that cannot be read, a type not accepted, the workspace's storage full and how much room is left,
too many files waiting, no connection, the server busy, file storage unavailable, the session ended, no
longer having access to the workspace (D-164).
Retry is there when trying again can be answered differently; Remove always. Pasting over 12 lines of text is inserted as a fenced block
on lines of its own, unless the caret is already inside code or the pasted text is already a code block (D-205).
The fence is longer than any inside the source; indentation and trailing blank lines survive copying.
The undo toast removes automatic formatting while keeping the pasted text and subsequent edits. If the block
has changed or cannot be identified uniquely, Undo keeps the current draft and explains why.
Quote formatting preserves list markers, nested quotes and blank lines; applying it again removes one outer quote.
Enter follows the renderer's fence rules, including tildes and longer fences, in both composers and message edits.
**What a paste becomes** (D-210): a spreadsheet's rows or a CSV become a table;
formatted text from a document, a page or a mail keeps its emphasis, links, lists, headings, quotes, code and
tables as markdown (an editor's coloured code is plain words); a long paste of code is a block named in its
language. A table or formatting says so with **Paste as text** one step away, a block of code with Undo, and
either keeps later edits as above; inside code a paste is always the words as they are, and
`Cmd/Ctrl+Shift+V` pastes the words as they are anywhere. A block always starts on a line of its own — after
words on the same line a fence is not one.

**Slash commands** (D-214). A `/` at the very start opens a list of commands, narrowed as letters are
typed; arrows move, Tab (or Enter, until the command is whole) writes it out with a space for its words, Esc
closes the list. Each is a door to what the product already does, painted, refused and put back as its
button is: `/me` (the words in italics), `/shrug`, `/topic` (nothing after it clears it), `/mute`,
`/unmute`, `/star`, `/unstar`, `/invite @name`, `/leave`, `/deepwork 30m|1h|2h|tomorrow|off`, `/search` (with
the search field's operators, D-224).
What is done is said in a toast; what is refused, under the box, with the words kept. An unknown `/word` is
not sent and the line says which commands there are; `//` at the start sends a slash as words; with files
attached, a line is words.

**Drafts** persist per channel in `localStorage`. Losing a half-written message on a channel
switch is unforgivable in a tool people live in.

**Who else is typing** is said quietly in the channel composer's footer, beside the hints — "Alice is
typing…", two by name, more as "Several people are typing…" — in a row that is always there, so nothing
moves when it appears (D-114). Never yourself; gone when their message arrives or after a few quiet
seconds. A reply composer shows none and announces none: typing belongs to the channel, and what is typed in a
thread never arrives in its feed (D-171). Only a member of the channel is heard typing in it.

---

## 6. Scroll and unread

The hardest problem in the product, and the subject of O-5, closed by D-199.

**Rules that hold however the feed is drawn:**

- **Anchor on read position, not on bottom.** If the user is scrolled up, incoming messages must
  not move the viewport. A "N new messages ↓" pill appears instead.
- **Stick to bottom only when already at bottom** (within 80px).
- **Opening a thread moves nothing in the feed**: it opens beside it. Inside the panel a reply
  arriving near the end keeps the end in view, and a reader further up is left where they are.
- **The unread marker** is a horizontal rule labelled "New", placed at
  `channel_members.last_read_message_id`. It persists while the channel is open — it does not
  vanish the instant the messages are seen, because it is the reader's place-holder, not a
  notification.
- **Marking read** happens when the bottom is reached with the page visible and its window focused,
  or on channel exit for the messages the person already reached. A blur cancels a pending read;
  returning to focus reads what is then in view. Never on mere render or from a visible window behind another.
- **Mark all channels read** (`Shift+Esc`, D-238) reads every channel the person is in to its newest
  message at once: the badges clear before the server answers and come back, with a toast, if it refuses;
  a toast says it was done. An answer waiting in a thread keeps its channel's badge, as below.
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

**Virtualization (O-5, D-199).** The feed is **not virtualized**: it draws a window of 50 messages and paginates on
scroll, and every page a reader scrolls back through stays mounted for as long as the channel is on screen. Measured
on 2,000 heavy messages the window switches in 52 ms against the `< 100ms` budget of `PRD.md` §5; what did not hold
was *returning* to a channel after a long read, which drew every page again (2.1 s). So a channel that leaves the
screen **keeps its newest page and no more**: coming back draws the window, and older history is read again a page at
a time as the reader scrolls to it. The scroll-anchoring rules above are unchanged by this and hold on every page that
is read.

---

## 7. Keyboard model

| Key | Action |
|---|---|
| `Cmd/Ctrl+K` | Command palette — the views (open questions, inbox, saved, search), channels (public ones not joined, marked so), group conversations, people, every settings page the person may open, the theme and language; and, whatever was typed, **Search messages for “…”** as its last row, so a query never ends in nothing (D-157) |
| `Cmd/Ctrl+/` | Shortcut reference |
| `Cmd/Ctrl+,` | Settings (D-146) |
| `Esc` | Close the topmost thing — the image viewer, palette, then edit, then the thread, files, pins or incident panel (focus returns to its root, or to the control that opened the panel) |
| `←` `→` | In the image viewer: the previous / next picture of the message, or of the files panel (D-159) |
| `Tab` | Into a list of messages — the feed, a thread's panel — lands on its one row: the one the keyboard was last on, or the feed's newest and the panel's root; from that row, through **its** controls (links, code, files, cards, reactions, the thread's line, then its bar) and on out of the list; `Shift+Tab` from after it comes back to the row. Other rows' controls are not Tab stops; the pointer and a screen reader's browse mode reach them as before (D-168) |
| `↑` `↓` `Home` `End` | Move message focus, in the feed and in a thread's panel |
| `T` | Open the focused message's thread in the panel, and move focus there |
| `R` | Reply to the focused message |
| `E` | Edit (own messages) |
| `Cmd/Ctrl+Shift+R` | Resolve / reopen the focused thread — on its root, or anywhere in its panel |
| `Alt+↑` `Alt+↓` | Previous / next unread channel |
| `Shift+F10` · `ContextMenu` | On a sidebar row: its context menu, under the row (D-165) |
| `Cmd/Ctrl+Shift+D` | Toggle Deep Work — on for an hour; another while is the account menu's or the palette's |
| `Shift+Esc` | Mark all channels read — every channel of the workspace the person is in, each to its newest message; an answer waiting in a thread still waits (D-147). Anywhere in the page, the composer included, but inside a dialog or a menu, whose Escape is its own; also **Mark all channels read** in the palette and the workspace menu (D-238) |

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
| Search | "No matches for `<query>`" + scope hint: where it looked, and whose words (D-166) | Inline progress in the input | Retry, query preserved |
| Notifications | "Nothing needs you" | Skeleton | Retry |
| Open questions | "Every thread is resolved" | Skeleton | Retry |
| Incident (panel) | "No incident" — declare one when something here is on fire; when the last was resolved | Skeleton, in the panel; the banner draws nothing until it knows | Retry in the panel; a timeline that fails says so with Retry, the controls still usable |
| Pins (panel) | "Nothing pinned yet" — pin a message everyone here should keep at hand | Skeleton rows, in the panel | Retry in the panel; a list that could not be brought up to date says so, with Retry |
| Channels to join (after an invitation) | "There are no public channels to join yet" + the way into the workspace | Skeleton rows | Retry; a join that fails part way names the channels and why, keeps them picked, focus on the button that tries again |
| Files (panel) | "No files yet" — what is shared here gathers in this list | Skeleton rows, in the panel | Retry in the panel; a further page that fails says so above **Load more**, and a list that could not be brought up to date says so, with Retry, keeping what it shows |
| Image viewer | n/a — opened on a picture | The thumbnail, in the picture's own box, until the full image has loaded | "The image did not load" + Retry; Download and Open original stay (D-159) |
| Thread | n/a — never rendered empty; a link to a root the channel does not hold says so in the panel | Skeleton under the root, in the panel | Retry in the panel, root intact; a root that could not be read back, Retry in its place |
| No workspace (`/`) | "You are not in a workspace yet" + the form to make one, where this server would let the person; otherwise "Ask for an invitation" and no form — never a form that would be refused (D-155). A refusal anyway, the rule having changed under the form, says to ask for an invitation above its button | n/a — the session gate's skeleton | The form's failures above its button or under the field they name |
| Invitation | n/a — a link always names a workspace or says it does not open | Skeleton card | "This invitation does not open" + the way home; any other failure, Retry |
| Sign-in | **A server with neither way connected** (a fresh one, waiting for its setup): *This server is not set up yet* — *Neither GitHub nor an emailed link is connected yet, but you can still sign in with a password. If you run this server, you can finish setting it up in the browser.* — and one link, **Set up this server**, which opens `/setup`, above the password form, which is never absent (R30). Otherwise the screen offers what the server has connected: GitHub's button where an app is, the link action where it sends mail, the password form always, and nothing until the server has said (D-138, D-179) | A skeleton the height of the button, announced as loading, until the server says what it offers; the email form's button is busy while it asks | The methods cannot be read (after a few automatic tries): the GitHub button stays, as it was before the screen asked at all, the password form stays (it does not depend on the answer) without the link action, and one small line says *We could not check which sign‑in options this server offers.* with **Try again** — the server answers a button it should not have offered with a defined 404 (`API.md`), and a failed round trip is already said here. One sentence per reason a sign-in came back unfinished (`API.md` §2): what happened, then what to do, above the same button (D-121); `email-taken` has two, chosen by whether the email form is shown. The email form: the same sentence whatever the address once asked, a refused address under the field, "switched off" or the failure above its button |
| Setup wizard (`/setup`) | n/a — a first step is always the code | Skeleton while the status is asked; each **Try the connection** busy while it calls out | A wrong code under its field; five wrong codes, said as a lock with the time it ends and that a restart ends it; setup not available — finished, or held by another browser, which the server does not tell apart (`API.md` §2) — said as one page naming both, with the fifteen minutes and the restart; too many tries from this browser, said with the wait; a failed try as its reason's three parts and nothing saved (§11); a finish refused, with the way back to a step that would allow it |
| Sign-up | n/a — a form, always | The button busy while it asks | On an *invite-only* server without an invitation, one sentence that an invitation is needed, with what to do; an address refused under the field; "switched off" or the failure above the button (D-179) |
| A workspace with nobody else | "Only you are here for now" + **Invite people** | n/a — the sidebar's skeleton | A send that fails says *not sent* and keeps the link to copy (D-179) |
| Invite people (dialog) | n/a — always the link, and the address field where the server sends mail | The send and the link buttons busy while they ask; the field is held | *Could not send the invitations* / *Could not make a link* above the link, the addresses kept; each address refused named with its reason (not an address, a daily limit, no mail on this server), the rest *asked of the mail server*, never *sent*; the link shown whatever happened |
| GitHub issues (Settings → Integrations), Create issues as you (Sessions & account) | Not connected, and not allowed, each in one sentence; not drawn at all without a GitHub App | Not drawn until the status is known | A refusal beside the button; the status is not changed by a failure (D-246) |
| Administration → Server (Settings → Server) | Each way in not connected says what that stops and offers to connect it; the two policies always have a value | Skeleton cards | A failed try as in the wizard, nothing kept and what was typed still there; the settings that could not be read, with Retry; a secret the key could not open, on its card; a setup still open, said in a sentence; anybody who is not the administrator is *not found* |
| Sign-in link | n/a — a link always names its address or says it does not open | Skeleton card | "Not complete" for a fragment that is not a link, "used or expired" for one that does not open — each with the way back to sign-in; any other failure to show it, Retry; a failure to sign in, said above **Sign in**, which stays |
| Native sign-in (`/sign-in/native`) | n/a — a pair the tab holds always asks; without one it says the sign-in has expired | Skeleton card while the session is read, and the button busy while the code is asked for | *Purlay for Mac was not opened* above the button, which becomes **Retry**, the pair kept; a session that ended meanwhile goes to sign-in saying so, the pair kept for after (D-191) |
| How long history is kept (owner) | n/a — always a window, forever by default | Skeleton in the dialog | Retry in the dialog; a save refused is said above the buttons and the choice stays. A shorter window is said in full and its button is red and names what it deletes (D-139 §4) |
| Exporting the workspace (owner) | "You have not exported this workspace yet." | Skeleton in the dialog; one being made says so, and the list is read again until it is not | Retry in the dialog; one already being made is said, and the list read again; any other refusal above the buttons. A failed export says why by its code; a ready one is a link that works once; once followed it reads "Downloaded", says to export again if no file arrived, and the list is read again so what the server holds replaces the guess (D-140) |
| Your data (Sessions & account) | "You have not exported your data yet." | Skeleton in the card; one being made says so, and the list is read again until it is not | Retry in the card; one already being made is said, and the list read again; past the day's limit, how many a day; any other refusal beside the button. An account suspended or erased before it was made is said as such; the rest as an owner's export (D-241) |
| How you sign in (Sessions & account) | n/a — always an address, and whether a link to it signs in; the GitHub row is there only when GitHub is linked, and is not offered otherwise | Skeleton in the card | Retry in the card (D-176, D-179) |
| Where you are signed in (Sessions & account) | "You are not signed in anywhere else." under this device's row | Skeleton in the card | Retry in the card; a sign-out refused puts the row back and says why in a toast (D-193) |
| Archived channels (General) | "No channel is archived." | Skeleton in the card | Retry in the card; a restore refused because the name is taken says to rename the other channel first (D-232) |
| Quiet hours (Notifications) | Off, with the profile's zone named; without a zone, a link to Profile | Skeleton in the card | A save refused or failed is said beside Save, and what was set stays (D-234) |
| Email (Notifications) | Not drawn where the server cannot send mail or the address is not verified | Not drawn until the server has said whether it can be offered | Whether it can be offered could not be read: said in the card, with Retry; a change refused is put back and said in a toast (D-240) |
| Stop link (`/mail/stop`) | n/a — a link always asks, or says it is not complete | The button busy while it asks | "This link does not open" for one too old or unknown, with the way to Purlay; any other failure said above the button, which tries again (D-240) |
| Accounts (Settings → Server) | "No account matches." | Skeleton rows | Retry in the card; a change refused is said in the card (D-233) |
| Erasing one's account | n/a — the dialog always says what goes and what stays | The button is busy while it asks | A username that is not theirs under the field; a session too old, with the way to sign in again; the workspaces they are the last owner of, by name; any other failure above the buttons. Done, the sign-in screen says the account was erased (D-139 §5) |
| Open invitation links | "No links are open" + **Make a link** | Skeleton rows | Retry |
| People (sidebar) | "Nobody else is here yet" under your own row + **Invite people…** for an owner or an admin | Skeleton rows | Retry |
| Channel details: members | "Nobody is in this channel. Anyone can join it." | Skeleton rows | Retry |
| Channel details: GitHub repositories | "No repository is connected…" above the Connect form | Skeleton row | Retry |
| Channel details: History (owner) | — (always a setting: the workspace's window until changed) | Skeleton row | Retry |
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
  that is a light neutral in the light theme and the dark navy in the dark (D-110, D-180). Check boxes and radio buttons are one primitive, the browser's input drawn in these tokens (D-182). Every colour pair is computed in both. Never colour alone
  to carry meaning: resolved, failed and unread each pair colour with a glyph or weight, for contrast
  and colour-blindness both.
- **Contrast:** WCAG AA minimum, including code syntax tokens, which are the usual casualty.
- **Motion:** quiet. Hover and focus ease in 120ms, the palette opens in 150ms, the thread folds
  on resolve (§4.3) and the reconnect bar slides. What opens from a control — a menu, a submenu, the
  inbox panel, a tip — grows out of the control in 150ms and leaves in 100ms; a dialog's backdrop
  fades as the dialog opens like the palette; a toast rises into its corner (D-211). No message entry
  animation — at conversational speed it reads as lag. Everything is instant under reduced motion.
- **Radius / elevation:** 6px for a control, 8px for a row, 10px for a card, 12px for the composer
  and an overlay. The interface is flat: regions are told apart by tone, and only what sits above
  something — an overlay, the hover controls, the composer, a card inside a message — has a shadow.

---

## 10. Not in Phase 1

Custom themes · resizable panes · reminders · rich link previews for non-GitHub URLs · emoji
picker beyond a recent/frequent row · read receipts · threads in a popped-out window. Pinning,
saved items and a status line were pulled into Phase 1 (D-130, D-128, D-131) and are in §2.

Some are permanent non-goals (`PRD.md` §6); the rest are simply not the wedge.

---

## 11. Setting up a server and making an account

D-179. The reference for how these look is the owner's three prototypes — the wizard, its error states
and the sign-up flow; every colour and size comes from `packages/tokens` (D-97), never from them. Where
this section and a prototype differ, this section is what is built.

**The setup wizard** is `/setup`, and the only screen a server with no user answers. A server with a user
answers `/setup` as it answers any address that does not exist; the page itself, on a finished server, says so, with one link — *Go to sign in*, or *Open Purlay* (the app's root) to someone already signed in. After a refused try the GitHub step shows one primary action, *Try again*, not a second *Try it* beside it. It is a focused page, like the welcome
step: a list of the eight screens down the left, each with a name and a line saying what it holds, the
current one marked and the finished ones ticked, and on the right the step — *Step 4 of 8*, its title, a
sentence, then the form. A line under the list says everything can be changed later in
**Administration → Server**. On a narrow window the list is not drawn and the *Step n of 8* line alone
says where the person is; nothing is missing, as in §2.

**Eight screens, nine steps.** The table's seven rows and the finish are the eight screens; the server
records nine steps (`SETUP_STEPS`), because the address and the sign-up policy — row 3 — are two of its
steps and one screen: confirming posts both, in that order. A screen is *done* when the server has passed
its last step. A person who closes the window comes back to the first screen not done; one already done
can be walked back to with **Back**, shows what was kept (the administrator, the workspace, *GitHub is
connected*), and a screen that keeps a secret never shows it again. The page asks the server for its
status once, on entry, and for its state once and again only after a step changed something — never on a
timer and never when the window gains focus, since the status shares the sign-in rate-limit bucket.
`/` on a server nobody has set up, for somebody not signed in, goes to `/setup`; every other address goes
to sign-in as it did.

| # | Step | What it asks, and what it does |
|---|---|---|
| 1 | **Setup code** | Before the code is asked, the page compares the address the server is configured for (`appUrl`, from `GET /setup/status`) with its own: when they differ it says so and links to `APP_URL`, since a code sent from another address is refused. "You own this server." The code the latest start wrote to the log; the sentence says where to find it (`docker compose … logs api`) and that it works for **one hour** — a restart writes a new one. A wrong code is said under the field. After five wrong codes setup is locked for fifteen minutes, the right code included; the page says so, says when it opens again, and that a restart of the server, which writes a new code, ends the lock at once. Accepted, this browser holds setup: another browser sending a code is told setup is not available — finished, or in progress in another browser; the server answers both alike, so the page names both. If the browser that holds setup has not been seen for fifteen minutes, a code from a later start takes the setup over at the step it reached, and the page says so: "Setup was started in another browser. If that browser is gone, wait fifteen minutes, restart the server and enter the new code; you carry on from the step it reached." |
| 2 | **Administrator account** | Name, email address and password. Says, before the button, that the address is **not verified yet** and is verified by the message the Email step sends — never by a sign-in link, which the library would let **remove the password and sign every session out**, and which is therefore never sent to an unverified address (D-179 §4). The password rules are the policy's (`passwordProblem` in `@purlay/types`, D-179 §4) — ten to 128 characters, not the address or the name or a word of it, not one of the commonest or one of them with digits added, not one or two characters repeated — shown before the field, and a refusal says which rule it broke |
| 3 | **Server address** | The address people open — `APP_URL`, shown, with GitHub's callback address; changing it is a deployment setting (Ruling R35) — and the one choice about sign-up: *Anyone can create an account* or *Only people who are invited* — the second already chosen |
| 4 | **Sign in with GitHub** | Why, then two numbered parts: *1 · Create an OAuth app on GitHub*, naming the path to take there and showing the callback address to paste, with **Copy**; *2 · Paste the values* — Client ID and Client secret, with the note that the secret is stored encrypted and never shown again. **Try it** checks the pair with GitHub and keeps nothing; **Save and continue** tries it and keeps it only if GitHub accepts it (two buttons, since a person may want to look before keeping — *Settings → Server* has the one, which is why it says *one button, not two*); **Skip for now**; **Back** |
| 5 | **Email** | The mail server and the sender; says what mail is for — sign-in links and invitations. **Try the connection and continue** sends a test message to the administrator's address — the letter that verifies it (below); skipping says what then stops working. The sender is **one plain address** — no name before it (*Purlay <x@y>* is refused), said in the hint before it is typed and under the field when refused, as the mail server's address is under its own field. Where the letter never came, **Send the letter again** (on this screen once connected, and beside the *We sent a message* line) sends it again through the relay already kept — the page cannot name it, since it is never shown again — and says *the link in the earlier message no longer works*; a relay that now refuses is said as a try is, by where it stopped, and the earlier link keeps working. Once the address is verified it reads **Send a test message again** |
| 6 | **First workspace** | A name and an address, as *Create workspace* asks (D-124); it starts with `#general` (D-174) |
| 7 | **Invite your team** | Copies the invitation link, and where mail is connected also sends it to addresses typed in. **Skip for now** is as good as any other way to go on |

**Nothing is saved on a failed try.** Steps 4 and 5 call the service for real before they save. A try
that fails shows, in this order, the same three things: **what happened** in a sentence under a red
heading, **how to put it right** as a short list, and **what the service answered**, as it said it, in a
monospace line. The field that is wrong is outlined, and the button becomes **Try again**; **Skip for
now** and **Back** stay. The email step also lists what it managed, one line each — *server address
resolved*, *connection made, TLS on*, *login rejected*, *test message not sent* — a tick, a cross, or a
hollow circle for what was never reached — read from the reason, since each reason is where the try
stopped: `unreachable` and `tls-failed` at the connection (a refused port is the common case, so the address line is ticked), `auth-failed` at the login,
the three refusals at the message. Each reason is a sentence of its own (`ProbeReason`, `API.md` §2) and
the build refuses a reason without one. The reply line is the service's words with whatever was typed
into the form taken out, at most 200 characters (D-179 §4.4). The wording of every reason but
`secret-rejected` and `auth-failed`, the prototype's two, is the builder's, to be confirmed:

| Reason | What happened | How to put it right |
|---|---|---|
| `secret-rejected` | GitHub knows the app and refused the client secret | Open the app's page on GitHub, **Generate a new client secret**, copy it at once — it is shown once — and paste it in |
| `client-unknown` | GitHub knows no app with this Client ID | Copy the Client ID from the app's page on GitHub again — the app may have been deleted, or the ID belongs to another GitHub (an Enterprise Server) |
| `auth-failed` | The mail server accepted the connection and refused the login | The password may be wrong or expired; the account may want an app password (usual with Google and Microsoft); the user name may need to be the full address |
| `tls-failed` | The server was reached and the secure connection failed | Use the port and the `smtps://` or `smtp://` form the provider names; a certificate this server does not trust is refused, and a relay past this machine must offer TLS unless the link to it is private |
| `unreachable` | Nothing answered at that address, or not in time | Check the host and port, and that this server may connect out to it |
| `sender-refused` | The login worked and the sender address was refused | Send from an address this account is allowed to use |
| `recipient-refused` | The mail server refused the administrator's address as a recipient | Check the address in the administrator step; some relays send only to their own domain |
| `message-refused` | The mail server took both addresses and refused the message | The relay's policy refused it — often the sender's domain (SPF, DKIM, DMARC): send from a domain the relay may send for |
| `unexpected-reply` | The answer was not one a working GitHub or mail server gives: an error or a busy reply from the service itself, a redirect, a reply too long to be one, or a web server, a proxy or another service at that address | Try again in a minute; if it stays, check the address — the reply shown says which it was |

**An app or a relay that is only in the settings** — put there by the environment (`GITHUB_CLIENT_ID`, `SMTP_URL`
and the others seed the settings on the first start, D-179 §6) and never tried — is **not called connected**: the
step says it is set in the server's environment and has not been tried, that a way in counts for the setup only
after a try, and offers *Try again* (enter the values and try them) and *Continue*, which **passes the step as it
is** — it is not left unpassed, and it counts toward nothing at the finish (§4.5). Only a try that worked is
*connected*.

**What the GitHub step cannot try is the callback address.** GitHub checks it only on its own screen when
somebody signs in, so the step shows the exact address — `APP_URL/auth/callback/github` — with **Copy**,
and says that GitHub's page *"The redirect_uri MUST match the registered callback URL"* means the app's
*Authorization callback URL* is not that address (D-179 §4.4).

**Settings → Server** (`/w/:slug/settings/server`, D-179 §4.8) is where the wizard's choices are changed
afterwards. It is **the server administrator's alone** — `isServerAdmin` on `GET /api/me`, never a
workspace role: an owner of a workspace is not offered it, and its address is *not found* for everybody
else, as the server answers `404` to the same people. It has its own heading in the navigation, *Server*,
under the account's and the workspace's, and is in the palette. Seven cards, in this order — the **GitHub App
for issues** (D-246) is the fourth, after E-mail: its App ID, slug, Client ID and secret, the private key (a
textarea) and the webhook secret, with the callback and webhook addresses to copy; tried as its client and then as
itself before it is kept, with `key-rejected` and `app-mismatch` said in the wizard's three parts; its secrets
never shown again; **Disconnect** asks once and says that links, the workspace token and feeds stay — over one query
that is read again after every change and never polled:

- **Sign in with GitHub** — the status (*Connected* with the app's Client ID, or *Not connected* and one
  sentence on what that stops), the callback address with **Copy**, **Replace credentials** (or **Connect
  GitHub**) opening the wizard's two fields, **Try the connection and save**, and **Disconnect**. The
  server tries the pair with GitHub before it keeps it, so there is one button, not two: a try that
  fails is the wizard's three parts — what happened, how to put it right, what GitHub answered — with the
  field outlined, nothing kept and what was typed still there; one that works closes the form and says
  *Saved. GitHub sign-in uses this app from now on.*
- **Single sign-on** (D-200) — the organisation's OpenID Connect provider: the status (*Connected* with its issuer
  and the client ID, or *Not connected* and one sentence on what that stops), the redirect address to register at
  the provider with **Copy**, **Connect single sign-on** (or **Replace provider**) opening four fields — the
  issuer, the client ID, the client secret and an optional button label — a note that people are linked to an
  existing account only when the provider says their address is verified and that account's is too, **Try the
  connection and save**, and **Disconnect**. It is tried as GitHub's is (one button, nothing kept on a failure,
  what was typed still there), with the words said for a provider: *The provider knows this client and refused its
  secret.*, *The provider does not know this client.*, *That address answers, but its discovery document names
  another issuer.*, *That is not an OpenID Connect provider this server can sign in through.*, and the provider's
  own reply as text. There is **no wizard step for it**.
- **E-mail** — the relay's host (never its user or password), the sender, **Replace mail server**, and
  **Disconnect**. Under the fields it says where the test goes: *We will send a test message to
  ⟨your address⟩* — a plain letter, no link; **Send a test message and save** is the one button, and the
  failure is the wizard's, with the same reasons.
- **Who can create an account** — *Only people who are invited* or *Anyone*, each with its one sentence,
  applied as it is chosen (*Saved. This applies from the next sign-up.*).
- **How people sign in** (D-239) — *Two-step verification*: *Optional* or *Required* (anyone with a password
  must turn it on before anything else, the administrator included); *Password sign-in*: *On* or *Off* (only
  GitHub or single sign-on; *admin:reset-password* turns it back on). Each applies as it is chosen (*Saved. It
  applies from the next request.*). With neither GitHub nor single sign-on connected, the row says to connect
  one first, and the server's refusal says the same. Disconnecting the last of them while passwords are off is
  not offered: the dialog says why, and has no **Disconnect**.
- **Who can create workspaces** — *Only the first person*, *Anyone who signs in*, or *Only these GitHub
  accounts* with the logins typed, comma-separated, held to GitHub's login rule before they are sent and
  by the server after; **Save** is enabled only when something changed.
- **Accounts** (D-233) — a search by name, username or address over the server's accounts, each row with its
  name, `@handle` and address, *Administers this server* where it does, and *Suspended* with its date where it
  is. **Suspend** asks once more on the row, in words that say the person is signed out on every device and
  cannot sign in until it is lifted; **Lift suspension** asks nothing. An administrator's row, the caller's
  own among them, has no button.

**Disconnecting asks first.** The dialog names what stops. When no other way for people to sign in would
remain — the page knows from which of GitHub, single sign-on and the mail server serve — it says so **before** the button
(*This is the last way for other people to sign in. Afterwards only your own password signs in…*) and the
button reads **Disconnect anyway**; the server is told so outright (`confirmLastChannel`). If the page was
wrong about it — somebody else changed the settings meanwhile — the server's refusal turns the same dialog
into that question, and nothing was taken.

**A secret the key could not open** (`needsReentry`) says so on its card — *This secret could not be opened
with the current key — enter it again.* — and the card's form is already open, with **Disconnect** beside it to let the unreadable value go (the
same question, the same last-way-in rule): entering it tries it and seals it under the current key
(`docs/CONFIG.md`). A server whose setup is still open refuses these changes
(*The setup of this server is not finished yet…*): the wizard's steps are the way until then. Motion is the
wizard's: a form arrives with the step-in movement, a failure with the nudge, and under reduced motion
neither plays. It is a settings page like the others: skeleton cards while it loads, *Could not read the
server settings* with **Retry** if it fails, one column on a phone.

**The email step's test message is the administrator's own verification letter.** It names the server,
carries a link that works once for 24 hours, and says to ignore it if unexpected; following the link —
in any browser, during the setup or after it — marks the address verified (D-179 §4.3). The step says so:
*We sent a test message to `<address>`. Open the link in it to verify your address.*

**When a step is skipped it says what stops working.** Skipping email: invitation links are not sent and
only copied, email sign-in and *create an account by email* are hidden; GitHub, if connected, still lets
everyone in. Skipping GitHub is said the same way.

**The finish rule.** **Finish setup** is disabled until at least one way for other people to sign in is
connected and its try succeeded — GitHub's app accepted, or the test message taken by the relay; the
administrator always has the password (D-179 §4.5). If both GitHub and email were skipped, the wizard says why in a
warning — *Nobody else could sign in. If you finished now, only you could, with your password; nobody you invited could get in* — and offers **Back to
GitHub** and **Back to email**; the button stays disabled until one is connected. The server refuses
the finish too (`API.md` §2).

**Close and return.** The browser that holds setup comes back to the step it reached, with what it had
saved; a step that was not completed saved nothing. **Without email** (GitHub only), the sign-in screen
shows no email form, a workspace's invitation dialog shows the link alone, and nowhere is a person told
to check their email.

**Motion.** A step enters from the right and the screen under it rises into place; a finished step's
mark settles; an error nudges its field once. Each lasts 0.2 second, from the motion
tokens (`duration-step`, `duration-mark`, `duration-nudge` — the token gate allows none longer than 200 ms, §9), and none loops. Under `prefers-reduced-motion: reduce` **nothing animates**: the step simply
changes. A test asserts it, since a rule left to taste is skipped.

**Sign-in, as it changes.** Under the one card — *Sign in to Purlay*, *Continue to your workspace* — the
GitHub button, *or*, the email field and **Send a sign-in link**, and at the foot *No account yet?
**Create account***. Each way is offered only where the server connected it, so a GitHub-only server
shows the one button and a mail-only server the field. A person who sent themselves a link is shown
*Check your email*: the address, *the link is valid for fifteen minutes*, **Send again** and **Change
address**. **The password is offered** (R30) unless the server's administrator turned password sign-in off
(D-239), because the administrator the setup made has one on a server with mail and on one without: under the GitHub button the card has an email field, a password
field and **Sign in**, and — only where the server sends mail — **Email me a sign-in link instead**, which
asks for a link to the address typed. The fields are named for a password manager (`username`,
`current-password`). A wrong address, a wrong password and an account with no password get the one
sentence *Wrong email or password.*, so the screen never says which accounts exist. Ten wrong passwords
for an address from this browser's network, or twenty for any addresses, in fifteen minutes, and the
screen says *Too many attempts. Try again in N minutes.* from `Retry-After` — never that the account is
locked, for it is not (D-179 §4); a server that did not answer is not blamed on the person. At the foot,
where the policy is *open*, *No account yet? **Create an account*** (the sign-up screen); where it is
*invite-only*, *Accounts are created by invitation.*, with no link. With password sign-in off the card has no
password form — GitHub, single sign-on and, where mail is sent, the link — and a password tried from a page
opened before it went off is told *This server no longer signs in with a password.*

**Turning on two-step verification first** (D-239). Where the server requires it, a person signed in whose
account has a password and whose second step is off sees, at any address of the application, only a card on
the navigation tone: *Turn on two-step verification* — *This server requires it of every account that signs in
with a password. Turn it on to carry on: you stay signed in.* — then Sessions & account's own card, with no
*Turn off*, and **Sign out**. Nothing of a workspace is drawn and no socket opens. Turned on, the backup codes
are shown once, as on Settings; **Done** reads the identity again and the page the person asked for is drawn,
on the same session, with no sign-in again.

**Single sign-on** (D-200) is the first button where a provider is connected, *Continue with ⟨label⟩* — the
operator's own label, shown as text, or *single sign-on* (*tek oturum açma*) — above GitHub's, as a secondary
button like it, leaving for `/auth/oidc`; the sign-up screen and an invitation page offer it as they offer GitHub
(the invitation page asks for its passport first). A server whose only way in is single sign-on has the button, the
password form and no *not set up* sentence. Two reasons are its own: *`oidc-unavailable`* — "Single sign-on could
not be reached, or did not give an identity this server trusts — wait a moment and try again, and if it stays, tell
whoever runs this server." — and *`email-unverified`* — "Single sign-on did not say your email address is verified,
so it cannot sign you in. Ask whoever runs your organisation's sign-in to verify it." Neither says which check
failed. *Sessions & account* names it under *How you sign in* (*Single sign-on — Linked*), and says an emailed link no
longer signs in to that account.

**When a GitHub sign-in did not finish**, one sentence says what happened and what to do, above the
button, and never blames the person (D-121). Two are new with D-179 §5. *`signup-closed`* — an
*invite-only* server and no invitation: "This Purlay server makes accounts by invitation only — ask
someone on it for an invitation link." *`email-taken`* — a local account has the address GitHub gave but has not verified it, so GitHub is not
linked to it, and the sentence follows what the screen offers. Where the server sends mail (the email form
is shown): "An account with that email exists, but its address is not verified yet, so GitHub cannot sign
in to it. Sign in with that account's password instead; once the address is verified, GitHub will sign in
to the same account." The only unverified accounts are password accounts made at setup (R30), so the
advice is the password on a server with mail and on one without. Where there is no mail: "… It is a
password account made when this server was set up: sign in with its password. This server sends no email,
so the address stays unverified and GitHub will not sign in to it." Neither sends anyone to Settings, which
has nothing to connect.

**Sign-up** is its own screen at `/sign-up`, at the same width, and only for a server whose policy is
*open* (`AuthMethods.signUp`): *Create your account*, the GitHub button where GitHub is connected, *or*,
where the server sends mail, an email field and **Email me a sign-in link** — the first link spent makes
the account — and *Already have an account? **Sign in***. There is **no password sign-up** and no name
field: the library's password sign-up is closed (D-179 §3), and the name comes from GitHub or is made
(D-138 §5). On an *invite-only* server the same address shows *Accounts are created by invitation*, *This
Purlay server does not take sign-ups. Ask someone on it for an invitation link, and open the link to make
your account.*, and *Sign in*, with no form and no button. An uninvited address that tries anyway, by a
route this screen does not offer, is told that an invitation is needed to make an account here, with what
to do — ask whoever runs it — never *no such account*.

**An invitation, to a person without an account**, shows the card of §2 (*You have been invited*) and both
ways in: **Continue with GitHub**, *or* an email address and **Email me a sign-in link**, each after the
invitation's passport (§2). This is the one place an *invite-only* server lets an account be made. A person
who has an account is pointed to sign-in with their password, and the invitation waits in the tab.

**A workspace with nobody else in it** says so, where the feed would be: *Only you are here for now*, and
under it *Invite your team and the conversation can start. They sign in with an email link or GitHub.*,
with **Invite people** — the dialog of §2, where mail is connected adding an address field above **Make a
link** and the link beside **Copy**. A send that is refused or fails says so, in words (§2, *By email*), and leaves the
link to copy; nothing says *sent* or *delivered* that was not.

**The native application's consent** is `/sign-in/native?challenge=…&state=…` (D-191). The application opens it
in the system browser, and the page asks — it never decides. The two values leave the address as the page
reads them and wait in the tab for ten minutes (`sessionStorage`), through GitHub's round trip, a password
sign-in or an emailed link, as an invitation's token does (D-115); a tab whose storage cannot be reached keeps
them in the address. Somebody not signed in is sent to sign-in, which says *Sign in to continue to Purlay for
Mac*, and the front door brings them back here (an invitation in hand comes first). Signed in, the card is
*Open Purlay for Mac?* — naming the person, their address and this server — with **Open Purlay for Mac** (focused),
**Cancel**, and *Sign out of this browser and use another account*, which signs this browser out and keeps the
question. Only the button asks the server for a code; the answer is `purlay://…`, opened by a full navigation,
and the card says *Back to Purlay for Mac — you can close this tab once the app has opened*, with **Open Purlay
for Mac again**, which opens the same code and makes no other. A page with no question — never asked, or ten
minutes old — says *This sign-in has expired* and offers *Go to Purlay*. The emailed link may open in another
browser, in which case the pair rides in the link's fragment after the token (`#<token>[.<invitation>]~<challenge>~<state>`)
and the sign-in keeps it for that tab.

---

## 12. The native client

The macOS application (D-186) implements this document's behaviour — the feed's rules (§6), the thread
panel (§4), the composer (§5), the keyboard model (§7), the required states (§8) — and **departs only where
the platform's own convention is better, each departure written here in the change that makes it**, so the
web is not the only place behaviour is specified. What is decided so far:

- **Layout.** The system split view in place of the rail: one sidebar holding the rail's destinations (inbox,
  open questions, saved, search) above the channels; the content column; and **one inspector** for the thread,
  files, pins and incident panels, one at a time as §2 says. The members list is a popover from the channel's
  header. Window minimum 720 × 480 points.
- **Look.** The system's controls, toolbar, sidebar and sheets, in the system's current design language, with
  the message feed, code blocks and cards drawn in this product's tokens (D-97). Light and dark follow the
  system; there is no theme picker, and no Midnight (D-184).
- **Keys.** Every row of §7 is bound: to a menu command where the platform has one, otherwise in the focused
  list. A bare letter (`R`, `T`, `E`) is never a menu equivalent, so typing in the composer cannot trigger it.
- **Notifications.** What interrupts is what the badge counts (D-148), as a local notice while the
  application is running and not in front, never in Deep Work, never for what was waiting when it opened;
  the Dock badge carries the same count. The application does not receive Web Push, so it is silent when
  quit (`PRD.md` §4).
- **What stays in the browser.** Setting a server up, workspace administration, the audit log, retention,
  exports and the GitHub feeds: the application opens the right page.
- **Signing in** is §11's consent: the application has no sign-in form of its own.


**Questions, decisions and search (D-204).** More → Mark as a question adds a root to open questions immediately. The thread's Question and decision section offers a current channel member an explicit editor: question checkbox, responsible channel member, selected live reply, decision note and optional reference. Visitors read it. Saving preserves the draft on failure; a stale edit shows the latest decision above the draft and requires reviewing that version before retry. Selecting an answer does not resolve the thread. A bounded answer preview links to its original message; deletion hides the preview and a deleted root hides its decision.

Open questions keeps existing unresolved threads and adds explicitly marked roots with no answers. Show switches between all, unanswered and assigned to me; order switches newest/longest waiting. Filters persist in the URL; pagination preserves the chosen order. Rows show ownership and elapsed days. No assignment notification or reminder is sent.

Search keeps words, channel and author in the URL and adds explicit status, question, content, date (whole days in the viewer's time zone, D-224) and repository controls. A filter can be used with no words. Results show selected-answer previews and decision notes with the original root. Saved searches opens a personal list with loading, retry and empty states; a named current search can be saved, revisited or removed, with pagination. Errors retain names and filters. Current visibility is always applied when running the search.

**Search operators (D-224).** The field takes filters typed with the words: `in:#channel` or `in:@person`, `from:@person` or `from:me`, `has:code`, `has:file`, `is:open`, `is:resolved`, `is:question`, `repo:owner/name`, and `on:`, `before:` or `after:` a `YYYY-MM-DD` day in the viewer's time zone (`after:` starts the next day). Keys ignore case; anything not a known key is words, and `"exact words"` keeps what looks like a filter as words. On Enter — and on any change of a control, which searches with what the field holds — the operators become the controls' own filters and the address keeps those and the remaining words; the field then shows those words, quoting one that would read as a filter. What is typed wins over a control changed with it, and the last of a kind wins. An operator that names nobody, or has a value no filter takes, stays in the words, is searched for as words and is said under the field in a polite status — never silently dropped, never blocking. Too few characters, too many, or an end before the start are said in the field. A *Search operators* disclosure under the field lists them. `/search` and the palette's *Search messages for* read the same operators.
