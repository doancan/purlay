# Spike — sending sign-in links over SMTP with nodemailer, under Bun

**Date:** 2026-10-14 · **For:** D-138 (#81) · **Verdict:** it sends, in order and in UTF-8, honours its
connection timeout, and refuses a closed port, a TLS mismatch and — told to — a server without
STARTTLS, each with a code. A password the server does not ask for is silently unused. And the first
run's conclusions were wrong, because the script that produced them had not been type-checked.

## Versions resolved

- Bun 1.4.2 (macOS arm64)
- `nodemailer` 10.1.1, `@types/nodemailer` 8.0.2 — installed in a scratch directory, not the
  repository; `nodemailer` has no runtime dependencies of its own
- `axllent/mailpit` (latest, run with `docker run`, not added to compose) as the SMTP server and
  mailbox

## What was run

```
$ docker run -d --rm --name purlay-spike-mailpit -p 1025:1025 -p 8025:8025 axllent/mailpit
$ bun run send.ts smtp://localhost:1025
sent <55ee9afa-6330-8171-eaa5-025345aa9bc6@example.test> [ "alice@example.test" ] 89 ms
$ bun run send.ts smtp://localhost:1
failed ESOCKET
$ bun run send.ts smtps://localhost:1025
failed ESOCKET error:100000f7:SSL routines:OPENSSL_internal:WRONG_VERSION_NUMBER
```

`send.ts` built `createTransport({ host, port, secure, connectionTimeout: 5000, greetingTimeout: 5000,
socketTimeout: 10000 })`, then `sendMail` with a subject in two languages, a text body holding a line
that is a single `.` (which SMTP ends a message with unless it is stuffed), and an HTML body with
Turkish letters. Read back through mailpit's API:

```
1 Sign in to Purlay — Purlay’a giriş alice@example.test
'Open this link to sign in:\r\nhttps://purlay.test/sign-in/email#abc\r\n.\r\nline after a lone dot'
<p>Open <a href="https://purlay.test/sign-in/email#abc">this link</a> — çğıöşü</p>
```

The lone `.` arrived as a line of the message, not its end; the subject and body kept every character;
the link's fragment survived.

The edges (`edge.ts`, `connectionTimeout: 1500, greetingTimeout: 1500, socketTimeout: 3000`):

```
timeout (blackhole) failed ETIMEDOUT 1506 ms
auth (no AUTH offered) sent 1228 ms
requireTLS without STARTTLS failed ETLS 8 ms
plain sent 8 ms
```

Both scripts type-check under the repository's settings (`strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `skipLibCheck: false`) against `@types/nodemailer`: `tsc exit 0`.

## What surprised us

- **The first run said the opposite, and was wrong.** It passed the timeouts and `requireTLS` as the
  *second* argument of `createTransport(url, …)` — which is the defaults of every message, not the
  transport's options — and so concluded that Bun ignored the timeout (75 s to fail) and that
  `requireTLS` let plaintext through. Type-checking the script (`'connectionTimeout' does not exist in
  type 'SendMailOptions'`) is what found it. The adapter therefore builds its transport from an object,
  typed, never from the URL plus a loose bag.
- **A password the server does not ask for is not used, and nothing says so.** mailpit offers no AUTH;
  credentials were configured and the message went out unauthenticated. Harmless to its recipient, but a
  relay that accepts it without them is the operator's to know: the adapter says so once at start, from
  what `verify()` learns, rather than at every send.
- **STARTTLS has to be asked for.** Without `requireTLS` a `smtp://` connection stays plaintext when the
  server does not offer the upgrade; with it, the send fails `ETLS`. Every message carries a sign-in
  link, so the adapter requires TLS for any relay past this machine (D-138 §6) unless the operator says
  the link is private.

## What was loosened

Nothing. No `any`, no cast, no rule turned off. The dependency enters the repository with the slice that
sends (D-138), with its justification under CONTRIBUTING §1.12.
