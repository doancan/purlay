# D-347. Copy rules: short strings end without a period, error titles say what did not load, and Turkish has one name for each thing

*Amended by D-349: Turkish addresses the person as siz.*

*Amended by D-350: English uses typographic apostrophes and British spelling.*

**Decided (the owner, 2026-11-26).** The design audit (D-345) found the catalogue punctuating the same slot two ways (a
filtered and an unfiltered empty state, one with a period and one without), error titles in three shapes, and Turkish
naming one thing two ways: Deep Work and *Derin Çalışma*, a thread and *konu* (which is a channel's topic), the
workspace left in English in two strings, and an issues state called *Biten* in its filter and *Bitti* on its pill.

**What changed.** The English and Turkish catalogues (`apps/web/src/i18n/catalogue`) follow these, and a new string does:

- Titles, labels, buttons, short placeholders and one-sentence empty states shown in a list, a card row or a dialog
  slot end without a period. Strings that take turns in the same slot punctuate the same way. Full-sentence errors,
  toasts, hints and bodies of several sentences keep their periods. No exclamation marks.
- An error state's title says what did not load: *Couldn't load people* / *Kişiler yüklenemedi*.
- Turkish names each thing one way: **Deep Work** (the feature's name, as its own screens, command and shortcuts have
  it), **thread** (never *konu*), **çalışma alanı**, **Bitti** for a finished issue, and the borrowed *issue* takes
  back-vowel suffixes (*issue’lar*, *issue’su*).
- The console's section for the GitHub App and the deployment's configuration is **Integrations** / *Entegrasyonlar*;
  notification setup is in the mail section.

**Rejected.**

- Taking every period off every one-sentence string: an error or a toast reads as a sentence and is one.
- Translating Deep Work as *Derin Çalışma* everywhere: it is the feature's name, and fourteen strings already used it.
- Switching threads to *konu*: it would collide with a channel's topic on the same screen.

**Open, for the owner.** The English catalogue mixed straight and curly apostrophes and British and American spelling (settled by D-350),
and the Turkish one mixed the formal and informal *you* (settled by D-349); each needs a choice before a sweep.

**Cost of reversing.** Low: strings in two catalogue files and the tests that quote them.
