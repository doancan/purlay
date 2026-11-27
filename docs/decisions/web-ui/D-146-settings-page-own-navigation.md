# D-146. Settings are a place: a page with its own navigation, not a menu of dialogs

**Context.** D-124 rejected *a Settings page* ("five choices fit in a menu"). By 2026-10-19 the
workspace menu held nine items, each a 480px dialog — members, invitations, the GitHub token, the
audit log, the workspace's name, retention, export — and the account menu sixteen: profile, four
Deep Work durations, three themes, two languages, shortcuts, notifications on this device and three
ways out. The owner looked at the running product and called the menus cramped and the screens
undesigned, and their own Superdesign screens (*Profile & Preferences*, *Members & Roles*,
*Notification Settings*, *Security & Audit Log*) draw a settings page with a navigation of its own.
D-124 was decided under the standing instruction to decide and proceed and said it was open to the
owner's reversal; this is that reversal. The owner delegated the design: "modern, enterprise SaaS,
clear, professional".

**Decided.**

1. **Settings are a route, `/w/:slug/settings/:section`**, inside the shell: the rail stays, and the
   sidebar's place holds the settings' navigation — *Back to <workspace>*, then **Account** (Profile,
   Preferences, Notifications, Keyboard shortcuts, Sessions & account) and, for an owner or an admin,
   **Workspace** (General, Members, Invitations, Integrations, Audit log, Data & retention). A member
   sees no Workspace group: a section they could only be refused is not drawn. `/w/:slug/settings`
   opens Profile. An unknown or forbidden section is *not found*, as any address is.
2. **One page shape.** A title and one sentence of what the page is for; then sections, each a card
   with a heading; each setting a row with its label and a sentence on the left and its control on the
   right, stacked below the narrow breakpoint. The column is `size-settings` (720px), centred in the
   main column on a ground a step below the cards (`surface-000`), as the screens draw it; a control
   in a row is `size-field` (320px) wide. Lists that are tables — members, the
   audit log, invitations — use the full card width with a toolbar above them.
3. **A choice takes effect when it is made; words are saved with a button.** The theme, the language,
   a role and a toggle apply at once, as they did in the menus. A form of words (profile, the
   workspace's name) has **Save** in its card, enabled only once something changed, with the outcome
   said beside it. No page-wide *unsaved changes* bar: each card saves what it holds, so leaving a page
   loses at most what was typed and not saved, and the browser's own warning is not borrowed for it.
4. **The menus shrink to what is done often.** The account menu: who you are, Deep Work, **Settings**
   (`Cmd/Ctrl+,`), the shortcut reference, **Sign out**. Theme and language move to Preferences; *Sign out
   everywhere* and *Erase my account* to Sessions & account. The workspace menu: the workspaces,
   **Create workspace…**, **Invite people…** (an owner's or an admin's, the one thing done from inside
   a conversation) and **Workspace settings**. The rail gains a gear at its foot that opens Settings —
   D-124 §4's objection, a gear "left with nothing in it", no longer holds. The palette offers every
   page by name.
5. **The settings are a chunk of their own.** Loaded when first opened, so the initial JavaScript does
   not pay for screens a person opens a few times a month (D-49, #687).
6. **Not drawn: what Purlay does not have.** The screens also draw SSO, SCIM, two-factor, an IP
   allowlist, seats, guests, billing and an email digest. Each is outside Phase 1 or refused
   (`PRD.md` §4, §7); a navigation entry for it would promise what is not there.

**Amended 2026-11-06 (#1179).** A confirmed member or integration change is applied to the
settings cache before refreshing it; an older pending read is cancelled first. Failed refreshes
retain the last confirmed rows/status, name that limitation and offer Retry. An uncertain write
(network, server failure or malformed receipt) is not described as unchanged. Confirmed self-role
changes also update the session’s workspace role before a refresh, so stale owner controls disappear.
An export link activation hides the once-only link while a fresh server read confirms whether it
was consumed. A context-menu right click changes nothing; a failed receipt read leaves the result
unknown until Retry, which only reads status and never replays a download. General offers archived
channels only when chat is enabled; long valid names wrap without hiding their distinguishing end.

**Rejected.**

- *Keeping the dialogs and widening them.* The problem was never the width alone: nine doors in one
  menu, each to a room of its own, with no place that says what the workspace's settings are.
- *A modal settings window* (Slack's preferences). It hides the conversation for longer than a dialog
  should (`UX.md` §1), cannot be linked to, and a member list or an audit log needs a page's room.
- *A page-wide unsaved-changes bar* (the Superdesign screens). It makes every toggle wait for a second
  press, and it needs a guard on every way out of the page for what a per-card Save does without one.

**Amends D-124** §3 and §4 (what the account menu holds, the rail's gear) and its rejection of a
Settings page. **Cost of reversing:** the route, the navigation, the pages (which reuse the dialogs'
logic), and the menu items moved back.
