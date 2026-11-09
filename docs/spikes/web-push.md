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

## Re-alert preference, 2026-11-09

For #1331, Chrome 157.0.8103.39 on macOS 27.0.1 was run headfully in a fresh, isolated persistent
profile. Only that profile was granted permission. No session, chat message or subscription was
created. The public application document answered 200 under its real CSP.

Two successive `new Notification` requests used the same non-empty tag and `renotify: true`.
Both emitted `show`, and both native objects exposed `renotify === true`. Two corresponding
`ServiceWorkerRegistration.showNotification` requests also resolved. The worker's immediate native
notification collection was empty, so that probe did **not** establish its retained count or a
visible OS banner. Its temporary worker registration was removed and the isolated browser closed.

The [Notifications standard](https://notifications.spec.whatwg.org/#showing-a-notification) defines
this as an alert preference when replacing a tagged notice, not a delivery receipt. The adapter
keeps its tag for coalescing and requests the preference; an empty page tag does not request it,
because the standard refuses that combination. The shared TypeScript DOM baseline does not declare
the optional member, so the browser boundary explicitly extends its native options type. No
runtime dependency or compatibility exception was added. Browsers that do not implement the member
can ignore it; their behavior was not measured in this probe.

Separately, the requesting user confirmed a real encrypted diagnostic push visibly arrived in their
normal macOS Chrome session. It used the existing production encryption and VAPID implementation,
targeted only their own registered devices, and made no database writes or synthetic chat/inbox
messages. This establishes that real delivery path on that device, not the timing of every future
OS banner. Unit and browser tests cover repeated native options, ordinary background DMs, and the
worker's built event wiring; the headless notification surface remains stubbed as documented in the
browser specs. No budget, assertion or security policy was loosened.


### Device attention controls (2026-11-09, #1348)

An owned Chromium profile on macOS exercised Web Locks on two same-origin localhost pages:
100 concurrent read/modify/write updates under one exclusive lock produced exactly 100 updates.
A native AudioContext was running in that profile both before and after a button-triggered resume;
this confirms API availability there, not that browsers universally permit autoplay or that a user
heard a cue. The implementation only creates/resumes audio from input or explicit preview, handles
refusal, and never queues old sounds. Native banners, sound and volume remain browser/OS preferences.

The API choice follows [Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)
and [Chrome’s Web Audio autoplay policy](https://developer.chrome.com/blog/web-audio-autoplay).
The independent desktop/sound controls were informed by
[Discord’s desktop notifications guide](https://discord.com/blog/how-to-manage-your-discord-desktop-notifications);
Purlay’s focused-page message card is our own interaction decision.
