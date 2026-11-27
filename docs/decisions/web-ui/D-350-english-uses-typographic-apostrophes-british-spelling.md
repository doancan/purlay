# D-350. English uses typographic apostrophes and British spelling — amends D-347

**Decided (the owner, 2026-11-27).** D-347 left open that the English catalogue mixed straight and typographic
apostrophes and British and American spelling. The owner asked for whatever the catalogue already mostly did. Counted
in `apps/web/src/i18n/catalogue/en.ts`: 130 typographic apostrophes against 22 strings with a straight one (all
*Couldn't…*), and *organise*, *cancelled*, *licence*, *recognise* against one *organize* and one *behavior*.

**What changed.**

- Every apostrophe in both catalogues is the typographic one (*Couldn’t*, *Purlay’ı*).
- English is spelled the British way (*organise*, *behaviour*, *cancelled*).
- `i18n.test.ts` refuses a straight apostrophe between letters in either catalogue, and the American spellings it
  knows in the English one.

**Rejected.**

- Straight apostrophes: fewer in use, and they read as typed rather than set.
- American spelling: two strings used it against a dozen British ones.

**Cost of reversing.** Low: strings in two catalogue files, the tests that quote them and one test's patterns.
