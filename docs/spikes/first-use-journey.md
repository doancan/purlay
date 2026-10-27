# First-use journey audit

Date: 2026-10-27. Application revision: `82e6bc42`.

The registration → workspace → channel → message → notification → attachment journey was exercised
in real Chromium against the built web client, the real API and an isolated PostgreSQL 18 database.
Two reproducible product defects were found. No application code, contract or test rule was changed
during the initial audit. Both findings were subsequently fixed; the follow-up below distinguishes
that verification from the original observations.

## Environment and boundaries

- macOS arm64, Bun 1.4.3, Playwright 1.64.1, Chromium 156.0.8078.4.
- A separate Compose project, `purlay-journey-audit`, exposed PostgreSQL on loopback port 55438.
  The unrelated database already listening on port 5432 was not used.
- The complete exploratory journey started from an empty database and created the administrator and
  an invited user through the browser. No seeded session was used in that journey.
- A local SMTP test relay accepted messages; the browser followed the actual verification, invitation
  and sign-in links from its mailbox. Delivery through a public mail provider was not tested.
- Attachments used the harness's directory store. Production Garage/S3, public HTTPS and operating
  system push delivery were not tested. Inbox notifications were tested.
- The existing tests ran at 1440 × 900 in light mode and 820 × 900 in dark mode. The continuous
  exploratory journey ran at 1440 × 900. The narrower viewport is not a phone touch-input test.

## Finding 1: a newly joined member is absent from an already-open workspace

Priority: P2; first collaboration requires a manual refresh.

Reproduction:

1. Finish setup as the administrator and keep the workspace open in browser A.
2. Invite a new email address. In browser B, follow the invitation and email sign-in links, accept
   the invitation and join `general`.
3. In browser A, create another channel and open **Add people**.
4. Search for the newly joined user's handle.

Observed: browser A still says “Nobody else is here yet” in the sidebar and “Nobody else is in this
workspace yet” in the dialog. There is no Add button for the new member. The original exploratory
run remained blocked in this dialog until its 120-second test timeout. The database contained both
workspace memberships. Reloading browser A made the member available, after which adding them and
exchanging live messages worked.

Expected: an existing member's open workspace learns that a person joined; the new member is
available in the sidebar, Add people and mention candidates without a reload.

Code evidence:

- `apps/api/src/ingress/http/invitations.ts`, `joinByInvitation`, runs the acceptance transaction
  without publishing a workspace update afterward.
- `apps/api/src/modules/workspaces/invitations.ts`, `acceptInvitation`, inserts the membership and
  audit record. It does not arrange publication of a member-list update.
- `apps/web/src/realtime/engine.ts` already refreshes the member query for `WORKSPACE_UPDATED`.
- `apps/web/src/app/query-client.ts` uses a 30-second stale time and disables refetch on window focus.
  Staleness alone does not periodically refetch a mounted dialog.

Suggested fix: publish the appropriate workspace update after a successful membership insert
commits, to the relevant workspace users. Retain membership checks and idempotent acceptance.
Add a two-browser regression that starts with a cached administrator member list and joins an
actually new user, then adds them to a channel without reloading.

## Finding 2: an attachment-only message has a falsely disabled Send button

Priority: P2; misleading send state and incorrect accessibility semantics.

Reproduction:

1. In a channel, leave the message text empty.
2. Select a file and wait until its upload finishes.
3. Inspect the Send button, then focus the composer and press Enter.

Observed: the file is ready, but Send remains grey and has `aria-disabled="true"`. Pressing Enter
sends the attachment successfully. In the exploratory run a UTF-8 text file named
`denetim-ğış.txt` reached the other browser and downloaded with byte-for-byte identical content.
The endpoint returned `application/octet-stream`.

Expected: a ready attachment is enough to make Send available. D-109 §7 explicitly permits
attachment-only messages. Empty text without any file must remain unsendable.

Code evidence: `apps/web/src/features/composer/composer.tsx` checks both text and upload items in
`send()`, but the `empty` value used by the button's `aria-disabled` considers only text. The
button's handler can therefore send something its accessibility state says it cannot send.
This audit does not claim that a native mouse click is blocked: `aria-disabled` is not the native
`disabled` attribute.

Suggested fix: derive the button state from the same sendability rules as submission, including
pending and failed uploads, and exercise attachment-only submission through the visible Send
control as well as Enter. Include a touch-input case, where Enter may insert a newline.

## What worked

The continuous journey, after explicitly working around finding 1 with a reload, confirmed:

- Administrator creation, address verification, first workspace and email invitation.
- A genuinely new invitee's email-link sign-in, invitation acceptance and channel selection.
- Channel creation and adding the invitee after the administrator refresh.
- Sending a message from the new member and receiving it live in the administrator's browser.
- A direct mention while the recipient viewed another screen, its unread Inbox entry and navigation
  from that entry to the channel.
- Image upload, delivery to the other browser, thumbnail decoding, full viewer, successful download
  and visibility after reload.
- Attachment-only text-file delivery through Enter and exact downloaded bytes, including a filename
  and content with Turkish characters.
- No uncaught page errors in the completed exploratory journey. Initial signed-out `/api/me` 401s
  and setup-state refusal responses were expected authentication/setup transitions.

The exploratory script records the known defects and applies the reload workaround. Its passing
exit status is not evidence that the uninterrupted journey is defect-free.

## Existing browser tests executed

```bash
DATABASE_URL=postgres://purlay:purlay@localhost:55438/purlay \
PURLAY_E2E_PROJECT=chromium-light PURLAY_E2E_PORT=5273 \
bun run test:e2e -- setup.e2e.ts first-run.e2e.ts inbox.e2e.ts \
  attachments.e2e.ts invitations.e2e.ts --workers=2 --reporter=list
# 11 passed (15.7s)

DATABASE_URL=postgres://purlay:purlay@localhost:55438/purlay \
PURLAY_E2E_PROJECT=chromium-dark-narrow PURLAY_E2E_PORT=5873 \
bun run test:e2e -- setup-paths.e2e.ts first-run.e2e.ts inbox.e2e.ts \
  attachments.e2e.ts private.e2e.ts waiting-sends.e2e.ts --workers=2 --reporter=list
# 10 passed (12.9s)
```

The final continuous exploratory run passed in 9.3 seconds with the recorded workaround and
attachment-only observation. It is not installed as a permanent regression test. Its script,
Playwright trace, screenshots and structured observations were kept locally under
`/tmp/purlay-journey-audit`; those temporary artifacts are not repository fixtures.

## Coverage gaps exposed

These are validation gaps, not additional confirmed product defects:

- The existing first-run test creates authenticated newcomers through a fixture. The setup-paths
  test registers a real invitee, but stops at joining the workspace. Neither carries that exact new
  account through channel membership, notification and attachment delivery in one scenario.
- The attachment browser tests send images with text. They do not check the visible Send control
  with a ready attachment and empty text, which is how finding 2 escaped.
- Production S3 storage, public email delivery and OS push notifications need separate environment
  validation; passing the local directory-store and SMTP-relay journey does not establish them.

Recommended order: fix the stale member list, align the attachment-only Send state, then preserve
both reproductions as regression tests. No rules were loosened during this audit.

## Follow-up: both findings fixed

The working-tree follow-up on 2026-10-27 fixes the two findings without a schema migration or wire
contract change:

- A new invitation acceptance returns the affected member IDs from its transaction; the HTTP layer
  publishes `WORKSPACE_UPDATED` after that transaction succeeds. An existing member accepting again
  produces no update. Outsiders are not recipients, and a publication failure does not reject the
  already accepted invitation.
- Send now considers attachments alongside text when advertising its disabled state. Existing
  pending-upload queuing and failed-upload feedback are unchanged.

Permanent regressions extend `apps/web/e2e/first-run.e2e.ts` to add the new invitee from the already-open
founder's browser, and `apps/web/e2e/attachments.e2e.ts` to click Send with a ready file and no words,
then download identical UTF-8 bytes in the other browser. Composer component coverage exercises both
pointer and touch-only modes. Invitation integration coverage checks recipient scope, repeated
acceptance, refusals and publication failure.

Verification:

- 1,345 targeted unit/integration/mutation-list tests passed, with no failures.
- The five browser specs (`setup`, `setup-paths`, `first-run`, `inbox`, `attachments`) ran across all
  four existing Chromium projects: 30 passed, 6 intentionally skipped. The skipped setup cases are
  restricted to one project each by their existing configuration.
- The original fresh two-person exploratory journey was rerun with the reload workaround removed
  and the attachment-only file sent through the visible enabled button: 1 passed in 6.4 seconds.
  Registration through file download completed without a reload workaround or uncaught page errors.

The original reproductions above remain as historical evidence. The production S3, SMTP and OS push
validation boundaries still apply.
