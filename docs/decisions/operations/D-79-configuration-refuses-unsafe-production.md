# D-79. Configuration refuses an unsafe production, and names the variable without quoting it

`ENCRYPTION_KEY` was checked for 44 characters, so 44 repeated letters passed, and the development
key committed to this repository was accepted in production; `DATABASE_SSL` defaulted to `false`
there; `APP_URL` accepted any scheme. The development key itself turned out to decode to 33 bytes,
not 32 — the check that would have caught it did not exist.

**Decided: the key is decoded.** Strict base64 of exactly 32 bytes, and not one repeated value
(all-zero included, which is what `AAAA…` decodes to). `Buffer.from` ignores what it cannot read, so
the shape is checked with a pattern first; a typo must not become a shorter key.

**Decided: in production the public development key is refused** — `DEVELOPMENT_ENCRYPTION_KEY`
lives in `platform/config.ts`, one home, imported by the test fixtures that use it. It is now a real
32 bytes.

**Decided: production refuses `DATABASE_SSL=false` (the default) unless `DATABASE_ALLOW_PLAINTEXT=true`.**
A self-hoster whose database shares a private compose network has a legitimate reason; the
acknowledgement makes that a sentence in their configuration rather than a silent default.
**Decided: `APP_URL` is `http` or `https`.** Every refusal is collected, names its variable and
never prints a value (`ARCHITECTURE.md` §10).

*Rejected: refusing plaintext outright.* It would make the default compose deployment impossible to
start. *Rejected: inferring TLS from `DATABASE_URL`'s `sslmode`* — a second source of truth for one
fact. *Rejected: an entropy estimate* — it rejects honest keys and accepts clever bad ones; the
checks above are the ones that are never wrong.

**Reversibility:** free; nothing is stored. An operator on a bad key sees it at the next start.

**Amended 2026-10-09 (second-round attack, all three verified against a real loader).**
*Canonical spelling:* the last base64 character of a 32-byte key carries two bits decoding drops, so
changing the public development key's final `E` to `F` produced the same bytes under a different
string and passed the string comparison. The key must now re-encode to exactly what was set, and the
development key is compared as **bytes**. *Low entropy:* a key that is a short pattern repeated
(`abcd`), a constant-step sequence (bytes 0..31) or has fewer than 16 distinct bytes is refused.
The threshold is measured: of 2,000,000 random keys the fewest distinct bytes was 22, and the
chance of one below 16 is under one in 10^12, so it never rejects an honest `openssl rand`. This is
a screen for patterns a person types, not an entropy proof — *rejected: estimating entropy*, as
above. *Integers:* `Convert` truncates `1.5` to `1`, so `SESSION_TTL_DAYS=1.5` was a day, silently;
every integer variable must now be written as digits.
