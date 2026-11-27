# D-338. iOS gets a native Swift client in its own repository, and the Apple clients share one Swift package — supersedes D-186's "no native iOS client"

**Context.** D-186 gave macOS a native client and left mobile as the installable web application (D-51, D-230). The
macOS client's wire types, sign-in, transport, realtime and outbox are about 36,000 lines of tested Swift with no
AppKit in them, and a second Apple client would otherwise copy them. An Android client is expected later.

**Decided (the owner, 2026-11-25).**
1. **A native application for iOS and iPadOS, in `purlay/purlay-ios`**, in SwiftUI. Deployment floor iOS 18, built with
   the iOS 27 SDK, using the newest platform where it has it: Liquid Glass from iOS 26, a system material before. Every
   OS-version branch sits in one place in the app (`PurlayDesign`); features never write one. It is modular as this
   server is: one feature package per server module, registered, and never importing another feature.
2. **The Apple clients share one Swift package, `purlay/purlay-swift`**: wire types, tokens, the client engine, the
   generator and the contract pin, versioned, with `macOS 26`+ and `iOS 18`+ as its platforms. `purlay-macos` and
   `purlay-ios` each pin one released version. D-186's "the Swift repository pins one version of that export and
   generates its types from it" holds there, once.
3. **The contract keeps its one home here** (D-186): `packages/types` and the bundle it publishes. An Android client
   generates its own types from the same bundle; it shares no Swift.
4. **The platform is named**: `X-Purlay-Client` carries `macos` or `ios`, and a native session is labelled
   `Purlay for macOS/…` or `Purlay for iOS/…` (D-191 amended).
5. **The four repositories — `purlay`, `purlay-swift`, `purlay-macos`, `purlay-ios` — live in the `purlay` GitHub
   organisation.**

**Not decided here.** *How the iOS application is distributed:* D-186 left the App Store because its terms and the
AGPL do not sit together, and iOS has no other channel for an ordinary person. The owner has to settle the licensing
basis before a build is released; until then the application is built and tested, not published. *Push to the
device* (APNs; the server speaks Web Push only, D-126) and *the sign-in page's wording*, which says "Purlay for Mac"
for every application, each need a decision before the iOS application is released. D-340 decides the iOS
minimum-client gate.

**Rejected.** *The installable web application alone (D-51):* the owner chose native for the platform's own feel and
performance, as for macOS. *Copying the macOS packages:* sign-in and realtime would drift. *A separate contract
repository:* a route and its type could no longer change in one commit. *Kotlin Multiplatform for every client:* it
trades native feel for a shared runtime, and the Swift already exists.

**Cost of reversing.** Low: a repository and a pinned package. Withdrawing the client takes the `ios` platform name with
it and nothing else.
