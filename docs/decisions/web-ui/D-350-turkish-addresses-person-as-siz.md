# D-350. Turkish addresses the person as siz — amends D-348

**Decided (the owner, 2026-11-27).** D-348 left open that the Turkish catalogue mixed the formal and the informal
*you*: most strings said *sen* (*bağla*, *sağlayıcın*, *yapabilirsin*) and a minority *siz*. The owner chose
*siz*.

**What changed.** The Turkish catalogue (`apps/web/src/i18n/catalogue/tr.ts`) follows these, and a new string does:

- A command on a control keeps the bare verb, as Turkish software does: buttons, menu items, tabs and action names
  (*Kaydet*, *Dizin ekle*, *Kanalı arşivle*).
- Everything said to the person uses *siz*: hints, descriptions, instructing placeholders, empty states, errors,
  toasts, confirmations and dialog bodies (*seçin*, *yapabilirsiniz*, *eklediniz mi*).
- *Your* is *-iniz* everywhere, in short labels too (*Profiliniz*, *Bildirimleriniz*).
- `i18n.test.ts` refuses the forms of *sen* it can see: the pronoun, *-misin*, *-ebilirsin*, *-emezsin*, *-iyorsun*.

**Rejected.**

- *Sen* throughout: it is what most strings said, but a work tool used across a company speaks to people it does not
  know.
- *Siz* on buttons too (*Kaydedin*): no Turkish software labels its controls so, and it makes every button longer.

**Cost of reversing.** Low: strings in one catalogue file, the tests that quote them and one test's pattern.
