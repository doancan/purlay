# D-186. macOS gets a native Swift client in its own repository, drawn in Liquid Glass — supersedes D-51's "not planned"

**Amended 2026-11-25 by D-338.** iOS gets a native client too, and the shared Swift lives in `purlay-swift`.

**Amended 2026-10-28 (#789).** The public client handshake carries optional additive capability
flags; `API.md` §2 owns their names and interpretation. A known flag exactly `true` advertises API
support, never permission; absent/unknown capabilities remain compatible with older peers. An open
optional object was chosen over version inference: additions do not bump the wire contract (D-58),
and a minimum-client gate would unnecessarily reject an older app for a new optional query. The
capability describes implemented behavior, not a rollout promise. Release versions keep D-185's
meaning, independently of these flags.

**Decided (the owner, 2026-10-26), supersedes the native-client clause of D-51 and the Tauri shell of D-14.**
D-51 chose one wrapped client and named its own reversal: "paying customers asking for it, with numbers". That
trigger has not fired. The owner has chosen to go native anyway, for the platform's own feel and performance, and
this decision records that as a choice made against D-51's reasoning, not as a measurement that overturned it.

- **A native application for macOS, written in Swift.** SwiftUI is the default; AppKit is used where SwiftUI is
  the wrong tool — the message feed's scrolling and the composer's text editing are the two expected places, and
  each such choice is recorded where it is made. The interface follows Apple's current design language, Liquid
  Glass, by using the system's own controls, toolbars, sidebars and materials rather than drawing glass by hand,
  and follows the system's accessibility settings (reduced transparency, increased contrast, reduced motion). It
  needs the macOS release that introduced Liquid Glass; older releases are not supported.
- **Its own repository, `purlay-macos`**, under the same owner, open source under the same licence and contributor
  agreement as this one (D-1). It is not a directory in this repository: this one is built, linted and verified
  with Bun tooling an Xcode project would fight, and the Swift client needs its own pipeline on macOS runners with
  signing and notarization, which must not block `main` here.
- **Distributed outside the App Store**: a signed, notarized download updated in place. Store review and the
  AGPL do not sit together, and a release channel the owner does not control is a cost D-51 already counted.
- **The contract keeps one home.** `packages/types` stays the owner of models, frames, shapes and error codes
  (`OVERVIEW.md`). This repository publishes a machine-readable export of it, versioned with the server; the Swift
  repository pins one version of that export, generates its `Codable` types from it and never writes a wire type
  by hand. A contract test runs the client against a real server of the pinned version, so drift is a red build
  rather than a decoding error in someone's app.
- **The visual values keep one home too.** `packages/tokens/tokens.json` owns colour, spacing and type (D-97). The
  Swift client generates its content-area values from it. System chrome — window, toolbar, sidebar, controls — is
  the system's and is not re-skinned.
- **Behaviour is `UX.md`'s.** The native client implements the same layout, thread interaction, keyboard model and
  states. Where the platform's convention is better, the departure is written into `UX.md` in the change that
  makes it; the web client is not the only place behaviour is specified.
- **The server no longer ships one client with it.** The app is installed by people and updated on its own
  schedule, so it will meet servers newer than itself. Responses are already additive (D-58) and the Swift client
  ignores fields it does not know; what it must also have is a way to declare its version and be told to update
  when a server needs a newer one. That mechanism is part of the plan, and is not built yet.

**What stays as D-51 decided.** Mobile is the installable web application. Windows and Linux use the web client.
No native iOS client is planned; a macOS app in SwiftUI makes one cheaper later, which is not a reason to start
it. The Tauri shell is dropped rather than built beside the native one: two desktop clients on the platform that
has one of them native is the "three mediocre clients" D-51 warned about, and D-2 says subtract.

**Considered and rejected.**

- *A directory in this repository (`apps/macos`).* One place for the contract, but it puts an Xcode project under
  `verify`, `knip`, `check:pr` and `mutate`, and a macOS pipeline under a CI that has been unavailable for billing
  more than once. The generated export gives the same single home for the contract without the coupling.
- *The Tauri shell of D-14.* It was the cheaper road and is the road the owner declined: a web view in a native
  frame is what this decision exists to leave.
- *Mac Catalyst or a cross-platform toolkit.* They give a native binary and not a native feel, which is the
  property being bought.
- *The Mac App Store.* See above.

**Accepted.** Everything D-51 listed, now incurred: a second design system, a second release channel, notarization,
platform expertise and permanent maintenance, and an Apple Developer account. Two clients to keep behaviourally
equal, held by `UX.md` and the contract test rather than by sharing code. Features land on the web first, as the
reference, and reach the app after. The app's first release is smaller than the web client by design, and its
contents are the plan's to decide.

**Open.** Whether the Apple Developer account exists and in whose name, and the first release's screens — the owner's,
and neither blocks the design. **How the app signs in** is not open: a browser session is a cookie
(`ARCHITECTURE.md` §7.1), so the app signs in once through the system browser and is handed a session of its own, by a
one-time code bound to a secret only the app holds. That handoff is a decision of its own, in the server work the app
waits for. Its parts were run — the system browser's session delivering a custom-scheme callback, the app holding the
session as an explicit `Cookie` header, the login keychain under the sandbox — and what was not run (other default
browsers, the GitHub round trip, the emailed link in a second browser) is checked against a real server before the
sign-in milestone closes.

**Reverses if** the app is not kept up to the web client's behaviour for two consecutive releases — then it is
archived and the web client is the product, which D-51 was.
