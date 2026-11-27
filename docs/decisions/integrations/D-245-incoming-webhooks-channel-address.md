# D-245. Incoming webhooks: a channel's address for CI and monitoring, its secret in the path — builds on D-12, D-34, D-134; closes #873

*Amended by D-305: workspace setup, real test posts and current authority at admission.*

**Decided (the owner gave the decision to the maintainer, 2026-11-01).** A team's CI and its monitors want to say
"deploy finished" and "error rate up" where the team already talks. A repository's feed (D-134) speaks only for
GitHub, signed GitHub's way; a CI job, Grafana or Alertmanager has nothing to sign with and knows only how to `POST`
JSON to an address it was given.

- **A channel's, made by an owner or an admin**, from a channel they can see, as a feed is (D-134 §2): listed with
  its name, who made it, when, and when it last posted; revoked from the same list. A direct message has none. At
  most `INCOMING_WEBHOOKS_PER_CHANNEL_MAX` (ten) a channel, counted under the channel's row lock. Each make and
  revoke is a row of the audit trail (`integration.webhook_created`, `integration.webhook_revoked`) with the name
  and the channel, never the secret.
- **The secret is in the path**, `/api/webhooks/incoming/:webhookId/:secret`: 32 random bytes of `platform/tokens.ts`,
  answered once inside the path, its SHA-256 alone kept (`incoming_webhooks.secret_digest`), so a copy of the
  database posts nothing; a post digests what it was given before anything is looked up and compares in constant
  time. Not a header: the tools this is for — Grafana's and Alertmanager's webhook, a CI step's `curl`, anything that
  speaks Slack's incoming webhook — are configured with one address and nothing else. What an address in a path
  costs, and what answers it: the server writes the path to no log (`pathWithoutSecret` in `edge.ts` writes
  `…/:webhookId/:secret` on every request line, the edge's and the error handler's), the API sends
  `Referrer-Policy: no-referrer`, and a hook is only ever `POST`ed, never opened in a browser. A reverse proxy's own
  access log is the operator's, as it already is for every other request; a leaked address is a hook revoked and
  made again, which is what the list is for.
- **One answer for everything that is not a live hook**: an id nobody made, a wrong secret, a hook revoked, its
  channel archived, its workspace deleted — `404 INCOMING_WEBHOOK_NOT_FOUND`, the same bytes, so the address says
  nothing to whoever guesses at it. A revocation racing a post wins or waits: the post marks the hook used first,
  under its row lock, and finds no row once the revocation commits.
- **The body is Slack's `text`, and only it**: `{ "text": "…" }`, markdown, 1 to `MESSAGE_CONTENT_MAX` characters, as
  `application/json` within the JSON bound every route has (D-80). Another field — Slack's `blocks`, `attachments`,
  `username` — is a `400`, not dropped: a message drawn without the part the tool meant to be read is the silent
  failure CONTRIBUTING §6.4 refuses. The server stores the text as written and renders nothing; the client draws it
  as a person's markdown is drawn (`@purlay/markdown`, D-101), which never trusts HTML.
- **What it posts is nobody's**, as a feed's event (D-134 §6): a root `system_event` with no sender, its metadata
  `{ kind: 'incoming_webhook', name }` (`messages_event_known`, 0074), on the wire as `Message.incomingWebhook` —
  the name it posted under, kept with the message so one revoked since still names what it said. The field is
  optional, an addition (D-58): a client before it draws the message as one nobody wrote. The web client names it
  by that name with the word *webhook* beside it, so a hook called after a person cannot pass for them. Nobody can
  edit it; an admin may remove it, as any message (D-34). It arrives by the path a person's does (`publishArrival`).
- **Quiet by default**: counted unread for every member, notifying nobody at any level and by no push — D-134 §7's
  rule for a feed — and its text is never read for `@`, so an alert that quotes `@alice` names nobody (D-12). A hook
  that could page people would be a way round the one rule this product is built on; a team that wants to be
  interrupted by an alert has an on-call tool for it.
- **Bounded on both sides of the secret**: each client address is charged to `WEBHOOK_BUDGET` before anything is
  looked up, the bucket GitHub's deliveries already use; each hook has its own, `INCOMING_WEBHOOK_BUDGET` (thirty at
  once, then one a second), charged once its secret held, so nobody but its holder spends it. Provisional (O-4).
- **Not a bot platform** (PRD §6, no marketplace, no automation builder): a hook only posts into its one channel.
  It reads nothing, answers nothing, and is not a member.
- **Not idempotent.** The same post twice is two messages. An `Idempotency-Key` would need a table and a sweep for
  a retry none of these tools sends; a CI step that retries a post it saw fail posts twice, which a reader sees.

**Considered and rejected.** *The secret in an `Authorization` header* — safer in a proxy's log, and unusable by the
tools the issue names, which take an address; accepting both would be two ways to authenticate one route for one
benefit. *Sealing the secret, as a feed's is* (D-134 §3) — a feed needs its secret back to check an HMAC; a hook
only compares, so a digest is enough and a stolen database opens nothing. *A bot user per hook* — D-134 rejected an
author row for a feed: a member, a mention target and a search result nobody asked for. *Reusing `githubEvent`* — it
is GitHub's event, in parts, and a hook's text is free markdown. *Parsing mentions* (above). *Accepting Slack's whole
payload* — blocks and attachments are a second renderer.

**Cost of reversing:** migration 0074 (the table, and the kind among `messages_event_known` — kept while any message
has it), `Message.incomingWebhook`, three channel routes, the post route, its budget and the panel.
