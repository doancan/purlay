# Purlay — Interaction Specification (`UX.md`)

> Authority: `PRD.md` owns *what* ships. This file owns *how it behaves* — layout, states,
> keyboard model, and the interaction rules for the resolvable thread.
>
> **Why this document exists:** Purlay's differentiator is not a feature, it is a behaviour.
> "Threads resolve inline" is three sentences in the PRD and an entire interaction model in
> practice. Building Phase 0's UI without settling this risks building a shape Phase 1 has to
> undo.

---

## 1. Principles

1. **The feed is the product.** Everything important happens in one column. There is no
   right-hand drawer, no separate thread view, no modal that hides the conversation behind it.
   A drawer turns a discussion into a footnote — which is precisely how knowledge gets lost.
2. **Density over comfort.** This is a tool for people who read a lot of text quickly. Default
   line height is tight, avatars are small, padding is minimal. Slack's spacing is designed for
   a wider audience than ours.
3. **Keyboard first, mouse optional.** Every action reachable by mouse has a key. The command
   palette is the primary navigation surface, not a power-user extra.
4. **Never move content under the reader.** Late-arriving content, expanding threads and
   resolving images must not shift what someone is currently reading. (§6)
5. **State is always visible.** Sending, failed, unread, resolved, offline — each has a
   distinct, non-decorative visual. A message whose delivery state is ambiguous is a bug.

---

## 2. Layout

One fixed shell, three regions. No resizable panes in Phase 1 — a saved layout is one more
state to sync for no benefit at this size.

```
┌────────────┬──────────────────────────────────────────────┬──────────┐
│ workspace  │  #api                          [search] [◐]  │          │
│  switcher  ├──────────────────────────────────────────────┤ members  │
│  (56px)    │                                              │ (opt.)   │
│            │              MESSAGE FEED                    │          │
│ ┌────────┐ │           (single column)                    │ 200px    │
│ │channels│ │                                              │          │
│ │  DMs   │ │                                              │          │
│ │  240px │ ├──────────────────────────────────────────────┤          │
│ └────────┘ │  composer                                    │          │
└────────────┴──────────────────────────────────────────────┴──────────┘
```

- **Workspace switcher (56px)** — avatars only, unread dot per workspace. Hidden when the user
  belongs to one workspace.
- **Sidebar (240px)** — channels, then DMs, ordered by `channels.last_message_at`. Unread
  channels are bold; unread **mentions** carry a count badge. Nothing else gets a badge.
- **Feed** — the single column. Max width 780px, left-aligned, not centred: eye travel matters
  more than symmetry when reading code.
- **Member list** — collapsed by default. Presence is decoration, not information.

**Below 900px** the sidebar becomes an overlay. Purlay is not a mobile product in Phase 1
(`PRD.md` §4), but it must not be broken on a narrow window.

---

## 3. The message row

```
  ┌ avatar  alice  14:32                                    [⋯] [☺] [↩]
  │ The retry backoff is 4s because the upstream rate-limits at 15/min.
  │
  │ ┌─────────────────────────────────────────────────── ts ─┐
  │ │ const backoff = 4_000;                          [copy] │
  │ └────────────────────────────────────────────────────────┘
  │
  │ 👍 3   🎉 1
  └ ▸ 4 replies · last 12m ago                      ● unresolved
```

- **Consecutive messages** from the same author within 5 minutes hide the avatar and header.
- **Hover controls** appear top-right and never reflow the row — they overlay it.
- **Timestamps** are relative under an hour, then `HH:mm`, then `MMM D`. Absolute time on hover.
- **Reactions** sit below the content, above the thread affordance.

### 3.1. Delivery state

| State | Appearance | Behaviour |
|---|---|---|
| `sending` | Full opacity, subtle clock glyph in the gutter | Paints in < 16ms, before any network call (`PRD.md` §5) |
| `sent` | Glyph removed | On `ACK`. **The row does not move** — the id was final from the start (D-8) |
| `failed` | Left border in the error colour, "Retry · Delete" inline | After 3s with no ACK. Never disappears silently |

The `sending` state is deliberately **not** dimmed to 50% opacity. Dimming implies "not real
yet"; in an optimistic UI the message *is* real, and flickering opacity on every send is visual
noise on the most frequent action in the product.

---

## 4. Threads — the wedge

### 4.1. Collapsed

A root message with replies shows one line beneath it:

```
  ▸ 4 replies · last 12m ago                          ● unresolved
```

Clicking it, or pressing `T` on the focused message, expands **in place**. The affordance is
absent when there are no replies — an empty thread control on every message is clutter that
teaches people to ignore that region.

### 4.2. Expanded

```
  │ The retry backoff is 4s because the upstream rate-limits at 15/min.
  │
  ├─▾ 4 replies                                    [Resolve] [Collapse]
  │  ┌ bob  14:35
  │  │ Is that documented anywhere?
  │  ┌ alice  14:38
  │  │ Only in the incident postmortem. Linking it here.
  │  └────────────────────────────────────────────────────────
  │  [ Reply to thread…                                        ]
  └─────────────────────────────────────────────────────────────
```

- Replies are **indented and rule-marked**, so the boundary is unmistakable while scrolling.
- The thread composer is inline and only present while expanded.
- Thread depth is capped at two levels by **invariant I-1** (`SCHEMA.md` §11), which owns the
  rule. The interaction consequence is what belongs here: a reply has no thread affordance of
  its own, so the limit is never something a user can bump into. Unbounded nesting is how a
  thread becomes unreadable.

### 4.3. Resolving

`Resolve` is available to any member (`ARCHITECTURE.md` §7.4) on the **root** message only.

On resolve:
1. The thread collapses with a short animation — the only place in the product with a
   non-instant transition, because a state change that reorganizes the reader's view needs to be
   *seen* to be understood.
2. The affordance line becomes `✓ Resolved by alice · 4 replies`.
3. A `system_event` message is **not** posted. The resolution is metadata on the root, not
   another line of chatter in a product whose thesis is less noise.

A resolved thread still expands on click, still appears in search, and never collapses its
parent message. Reopening is the same control, inverted.

### 4.4. The open-questions view

Reached from the palette (`Cmd+K` → "Open questions") or the workspace header. It lists
unresolved root messages that have at least one reply, workspace-wide, newest first, grouped by
channel — backed by `idx_messages_unresolved`.

This view is the product's argument in one screen: *these are the questions your team has not
finished answering.* Slack cannot produce it at any price. It ships in Phase 1, not later.

---

## 5. Composer

Plain textarea, GFM, no WYSIWYG toolbar (`PRD.md` §4.1).

| Key | Action |
|---|---|
| `Enter` | Send |
| `Shift+Enter` | Newline |
| ` ``` ` then `Enter` | Opens a code block; `Enter` inside it inserts a newline, `Cmd/Ctrl+Enter` sends |
| `↑` on an empty composer | Edit your last message |
| `Esc` | Cancel edit / collapse thread / close palette |
| `@` | Member autocomplete — **`@here` and `@channel` are not offered and are rejected on send** (D-12) |

Pasting an image uploads immediately and inserts a placeholder; the message can be sent while
the upload is still in flight. Pasting over ~12 lines of text is inserted as a fenced block
automatically, with an undo toast — a paste that silently becomes a code block with no way back
is worse than no help at all.

**Drafts** persist per channel in `localStorage`. Losing a half-written message on a channel
switch is unforgivable in a tool people live in.

---

## 6. Scroll and unread

The hardest problem in the product, and the subject of **O-5**.

**Rules that hold regardless of how O-5 is decided:**

- **Anchor on read position, not on bottom.** If the user is scrolled up, incoming messages must
  not move the viewport. A "N new messages ↓" pill appears instead.
- **Stick to bottom only when already at bottom** (within 80px).
- **Expanding a thread anchors on the root message**, which stays put while content grows
  beneath it.
- **The unread marker** is a horizontal rule labelled "New", placed at
  `channel_members.last_read_message_id`. It persists while the channel is open — it does not
  vanish the instant the messages are seen, because it is the reader's place-holder, not a
  notification.
- **Marking read** happens when the bottom is reached, or on channel exit. Never on mere render.

**On O-5:** variable-height rows with expandable children defeat naive virtualization, and a
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
| `Esc` | Close the topmost thing — palette, then edit, then expanded thread |
| `↑` `↓` | Move message focus |
| `T` | Expand / collapse the focused thread |
| `R` | Reply to the focused message |
| `E` | Edit (own messages) |
| `Cmd/Ctrl+Shift+R` | Resolve / reopen the focused thread |
| `Alt+↑` `Alt+↓` | Previous / next unread channel |
| `Cmd/Ctrl+Shift+D` | Toggle Deep Work |

Focus is **always visible** — a 2px ring, never `outline: none`. This is a keyboard-first
product; an invisible focus ring is a broken product, not a style choice. (`PRD.md` §5)

---

## 8. Required states

Every view implements all four. An unhandled empty state is an incomplete feature, not a polish
item (`CONTRIBUTING.md` §4).

| View | Empty | Loading | Error |
|---|---|---|---|
| Channel feed | "No messages yet" + composer focused | Skeleton rows, no spinner | "Couldn't load messages · Retry" — the composer stays usable |
| Search | "No matches for `<query>`" + scope hint | Inline progress in the input | Retry, query preserved |
| Notifications | "Nothing needs you" | Skeleton | Retry |
| Open questions | "Every thread is resolved" | Skeleton | Retry |
| Thread | n/a — never rendered empty | Inline spinner under the root | Retry inline, root intact |

**Connection loss** shows a single non-blocking bar: `Reconnecting…`. The composer stays
enabled — messages queue and send on reconnect (`ARCHITECTURE.md` §5.4). Disabling input on a
transient network blip is the failure mode this whole architecture exists to avoid.

**Deep Work** shows a persistent, quiet indicator in the header with its expiry. A mode you can
forget you are in is a mode that loses you messages.

---

## 9. Visual system

Decided here so Phase 0 does not invent one at random.

- **Type:** system UI stack for prose; `ui-monospace`/`SF Mono`/`JetBrains Mono` for code.
  Base 14px, code 13px, line-height 1.5 prose / 1.45 code.
- **Colour:** dark theme first — this is a tool that sits open beside an editor. Light theme in
  Phase 2. Never colour alone to carry meaning: resolved, failed and unread each pair colour
  with a glyph or weight, for contrast and colour-blindness both.
- **Contrast:** WCAG AA minimum, including code syntax tokens, which are the usual casualty.
- **Motion:** effectively none. The only transitions are the thread collapse on resolve (§4.3)
  and the reconnect bar. No message entry animation — at conversational speed it reads as lag.
- **Radius / elevation:** 6px, one shadow level. Cards and code blocks are separated by border
  and background, not by depth.

---

## 10. Not in Phase 1

Custom themes · resizable panes · message pinning · saved items · reminders · rich link previews
for non-GitHub URLs · emoji picker beyond a recent/frequent row · read receipts · user status
messages · threads in a popped-out window.

Some are permanent non-goals (`PRD.md` §6); the rest are simply not the wedge.
