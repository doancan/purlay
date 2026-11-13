/** The workspace address shared by initial setup and workspace creation. */
export const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/**
 * What a name suggests as an address: the part of it a URL would keep. Accents and Turkish letters are
 * folded to their plain ones (`Çağrı` is `cagri`, `İstanbul` is `istanbul`), as a channel name's are,
 * not dropped. The fold is written here and not imported: chat owns `fold`, and the shell may not
 * import a module (D-277).
 */
export const slugOf = (name: string): string =>
  name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/ı/gu, 'i')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
