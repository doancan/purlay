# Spike — Web Push encryption and VAPID with Bun's WebCrypto, no dependency

**2026-10-13.** Bun 1.4.2, macOS arm64, run in a scratch directory. Nothing in the repository was
modified. For #78.

A push to a browser is an HTTP `POST` to the endpoint its push service gave it, with the payload
encrypted for that browser (RFC 8291, `aes128gcm`) and the request signed by the application server's
key (RFC 8292, VAPID: a JWT signed with ES256). The `web-push` package does both on Node's `crypto`.
`CONTRIBUTING.md` §1.12 prefers a platform API to a dependency, so the question: **does Bun's
`crypto.subtle` do every step, in the formats the RFCs need?**

## Verdict

| Question | Result |
|---|---|
| ECDH P-256 `deriveBits` with a JWK private key and a raw 65-byte public point | **Yes** |
| HKDF-SHA-256 `deriveBits` of 32, 16 and 12 bytes | **Yes** |
| AES-128-GCM `encrypt` with a 12-byte nonce | **Yes** |
| The whole of RFC 8291 Appendix A — same keys, salt and auth secret — gives the RFC's body byte for byte | **Yes** (`MATCH true`) |
| ECDSA P-256 / SHA-256 `sign` returns the 64-byte `r‖s` JWS wants (not DER) | **Yes** (`SIG 64`), and `verify` with the raw public point accepts it |
| `generateKey` gives a raw public point of 65 bytes and a JWK `d` of 43 base64url characters | **Yes** |

## What had to be loosened

Nothing. No dependency, no polyfill, no flag.

## Commands and output

```
$ bun run spike.ts
MATCH true
SIG 64 true
GEN raw pub 65 43
$ bun --version
1.4.2
```

The script is the RFC's Appendix A inputs run through `importKey` (JWK private, raw public),
`deriveBits` (ECDH, then HKDF for the IKM, the content-encryption key and the nonce), a padded record
(`plaintext ‖ 0x02`), `encrypt` (AES-GCM), and the header `salt ‖ rs(4096) ‖ idlen ‖ keyid`.

## What the original spike did not show

The original spike did not check delivery through a real push service. The production check below
covers FCM and Chrome; Mozilla and Apple delivery remain unmeasured here.

## Production delivery evidence 2026-10-28

For #796, the production transport was checked with Bun 1.4.3 and Chrome 156.0.8078.48 on macOS
arm64. The server initially returned `publicKey: null`. A stable VAPID pair and subject were added
to its private deployment configuration, and the API and scheduler were recreated and became
healthy. The operator procedure is in [CONFIG.md](../CONFIG.md).

An isolated persistent Chrome profile subscribed through the existing Settings switch. Its
notification permission was granted for the test profile only. Chrome's background networking
was enabled; an automation launch with it disabled did not receive the first test.

With every Purlay page closed, a diagnostic payload was encrypted and signed on the production
server using `encryptPush`, `freshParts`, `vapidSigningKey` and `vapidAuthorization`. Its only
target was that isolated profile's subscription, matched by an endpoint fingerprint. The push
service was FCM. The worker's real notification collection was then read while no Purlay page
was open:

```text
GET /api/push/key: 200, publicKey present
browser subscription: present
POST to fcm.googleapis.com: 201
Purlay tabs open: 0
service workers: 1
notifications with the diagnostic tag: 1
title: Purlay bildirim testi
body: Kapalı sekme Web Push teslimat testi.
```

The diagnostic notification was closed afterwards. No chat or inbox message was created, and no
other subscription was targeted. Private keys, subscription endpoints and session values are
omitted. This verifies the production encryption, signature, push-service and worker path;
message eligibility is covered by the sender's integration tests. An OS banner still depends on
the device's own notification settings.

The notification fix also passed all four targeted Chromium end-to-end tests: the existing
background mention and push-worker tests, channel/thread focus with all three channel levels,
and a two-channel reconnect whose lazy notification chunk is delayed while one channel is read.
Seven hand-written mutations were caught, with none surviving or stale. The added device test
has keyboard and accessibility coverage and reports browser acceptance without claiming OS
delivery. No runtime dependency, schema or wire-contract change was needed; no application
budget, test timeout or assertion was loosened.
