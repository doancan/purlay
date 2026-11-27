# D-360. The Apple clients are one repository, purlay-apple — amends D-338

**Decided (the owner, 2026-11-26).** D-338 put the iPhone and iPad client in `purlay-ios`, kept the macOS client in
`purlay-macos` (D-186) and the code they share in `purlay-swift`. Most changes reached the shared engine and the
screens together, so each one was a pull request, a release and a version bump in several repositories, and two
design systems were drifting.

**What changed.**

- **`purlay/purlay-apple` holds every Apple client** — the native iOS, iPadOS and macOS apps (watchOS to follow) and the
  Swift they share: wire types, tokens and the client engine, generated from this repository's contract bundle. It has
  its own decision record (its ADR 0001).
- `purlay-ios`, `purlay-macos` and `purlay-swift` are archived and read-only; their history is part of the new
  repository's.
- This repository's `README.md` and `docs/OVERVIEW.md` say so. Mobile on iPhone and iPad is the native app, not the
  web client installed from the browser; the installable web client stays for browsers and for Android until its
  own client exists.
- Decisions that name the old repositories (D-186, D-338 and those citing them) are history and stay as written.

**Rejected.**

- Keeping three repositories with the engine released as a versioned package: every engine change would wait on a
  release and a bump in each app.
- Moving the Swift code into this repository: SwiftPM fetches a package only from a repository's root, and Swift
  releases would follow the server's tags.

**Cost of reversing.** High for the Apple repository, none here: this repository only names it.
