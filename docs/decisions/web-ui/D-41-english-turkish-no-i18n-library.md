# D-41. The interface ships in English and Turkish, with no i18n library

**Decided: real internationalisation from the first screen, built on `Intl` and typed message
catalogues rather than a framework.**

Waiting is the expensive option: Phase 0 builds the client, and retrofitting translation means
touching every component that ever rendered a string.

**The mechanism.** One catalogue module per locale, a `Messages` type generated from the English
catalogue so a missing or misspelt key is a **compile error**, and the platform's own `Intl` for
everything that varies: `Intl.PluralRules`, `Intl.DateTimeFormat`, `Intl.NumberFormat`, and
`Intl.RelativeTimeFormat` for the *"last 12m ago"* strings `UX.md` §3 specifies. Only the active
locale's catalogue is loaded; the other never enters the bundle.

**Why no library.** `PRD.md` §5 fixes the initial bundle at 250 KB gzipped, and React, the markdown
renderer and the highlighter already spend most of it. The runtime this needs is a lookup and a
formatter call. Compile-time key checking is stronger than what most libraries provide, and
`CONTRIBUTING.md` §1.12 prefers a web standard over a dependency. **Lingui is the named fallback**
if message extraction from source becomes the bottleneck — that is a tooling problem, and adopting
it later does not change the call sites.

**Locale selection** follows `navigator.language`, is overridable, and persists in
`localStorage` — per device, no schema. A `users.locale` column arrives with Web Push (Phase 2),
because that is the first user-facing text the *server* generates and the first time the choice
has to follow the person rather than the browser.

**Message content is never translated.** Only the product's own chrome. Translating what people
wrote to each other is not a feature, it is a misunderstanding.

**Accepted cost, stated because it is real.** Two catalogues means every new string is two edits
and the Turkish one will lag. The compile error stops a *missing* key, not a *stale* one.
Turkish text also runs longer than English, so layouts are built to wrap rather than to fit.

**Related:** the Turkish locale is exactly why D-40 pins the database collation. The interface
language must never reach identifier comparison.
