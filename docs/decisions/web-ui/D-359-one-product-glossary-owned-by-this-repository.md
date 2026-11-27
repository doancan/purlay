# D-359. One product glossary, owned by this repository, and Apple's words for signing in and out — amends D-348

**Decided (the owner, 2026-11-27).** D-348 gave Turkish one name for each thing, but only for the words it had found,
and only for the web. The native Apple apps, which are generated from this repository's contract and drawn in its
colours, name the same things in their own words: sign in and sign out were *giriş yap* and *çıkış yap* on the web
(75 and 11 strings) and *Oturum Aç* and *Oturumu Kapat* in the Apple apps; two-step verification was named three
ways across the clients; deleting an account was *Erase* in the web's English and *Delete* in the Apple apps.
Nothing said which was right.

**What changed.**

- [`GLOSSARY.md`](../../GLOSSARY.md) is the single list of product terms in English and Turkish. A client in any
  language follows it; this repository owns it, because it owns the contract and the first client.
- Turkish for signing in is **oturum aç** and for signing out **oturumu kapat**, as the platform's own words are, in
  every form (*oturum açın*, *oturumu kapatın*, *yeniden oturum açın*, *oturum açma* as the noun). *Giriş* and
  *çıkış* no longer name either. The web catalogue (`apps/web/src/i18n/catalogue/tr.ts`) follows, and so do the tests
  that quote it.
- Two-step verification is **İki Adımlı Doğrulama** (*Two-step verification*) everywhere; *İki Faktörlü* and
  *Two-Factor* are not used. The web already said so.
- Deleting an account is **Delete account** in English (the web's *Erase my account* became *Delete my account*, as
  the Apple apps and the platform's account-deletion rule have it) and **Hesabı sil** in Turkish (the web's first-person forms, *Hesabımı sil* and *Hesabınızı sil*, are the same term). What the deletion
  does to the person's words is unchanged.
- The address form stays **siz** (D-350), and the glossary says it once for every client.

**Rejected.**

- The web's *giriş yap* and *çıkış yap* for everyone: they were the majority on the web, but the Apple apps are
  built from the platform's wording, and a person with an iPhone and a browser should not read two words for one
  action.
- A glossary kept in each client: it is the situation that produced three names for one thing.
- A machine-checked term table next to the catalogues: worth having when a second client reads it; until then the
  list is a document and the web's tests quote the terms.

**Cost of reversing.** Low: the glossary, strings in the two catalogue files and the tests that quote them.
