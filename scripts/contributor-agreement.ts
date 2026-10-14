/**
 * Whether a pull request may be merged under the contributor licence agreement (#122, D-145).
 *
 * The maintainers — the owners `CODEOWNERS` names for the whole repository, who hold the copyright
 * `NOTICE` names — and Dependabot need no signature. Anybody else has signed: their GitHub login is in
 * `.github/cla-signatures.json`, which they add to themselves, in their first pull request or one of its
 * own. Nobody signs for anybody else: an entry the pull request adds must be its author's own.
 */

/** The agreement's version a signature is for: a later version is signed again. */
export const CLA_VERSION = '1.0';

/** Bots whose changes are dependency versions, with no work of authorship in them. */
const BOTS: ReadonlySet<string> = new Set(['app/dependabot']);

export interface Signature {
  readonly github: string;
  readonly name: string;
  readonly version: string;
  readonly date: string;
}

/** The signatures file, checked: a list of entries with every field, one per login. */
export const parseSignatures = (text: string): readonly Signature[] => {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('the signatures file is not a list');
  const signatures = parsed.map((entry: unknown, at): Signature => {
    const record = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<
      string,
      unknown
    >;
    const field = (name: string, pattern: RegExp): string => {
      const value = record[name];
      if (typeof value !== 'string' || !pattern.test(value)) {
        throw new Error(`signature ${String(at + 1)} has no valid "${name}"`);
      }
      return value;
    };
    return {
      github: field('github', /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/),
      name: field('name', /\S/),
      version: field('version', /^\d+\.\d+$/),
      date: field('date', /^\d{4}-\d{2}-\d{2}$/),
    };
  });
  const logins = signatures.map((signature) => signature.github.toLowerCase());
  const twice = logins.find((login, at) => logins.indexOf(login) !== at);
  if (twice !== undefined) throw new Error(`${twice} has signed twice`);
  return signatures;
};

/** The owners `CODEOWNERS` gives the whole repository (`*`), without their `@`. */
export const maintainersIn = (codeowners: string): readonly string[] => {
  const line = codeowners
    .split('\n')
    .map((text) => text.trim())
    .find((text) => text.startsWith('* ') || text.startsWith('*\t'));
  if (line === undefined) throw new Error('CODEOWNERS names no owner for the whole repository');
  return line
    .split(/\s+/)
    .slice(1)
    .filter((owner) => owner.startsWith('@') && !owner.includes('/'))
    .map((owner) => owner.slice(1));
};

export type Verdict =
  | { readonly allowed: true; readonly why: 'maintainer' | 'bot' | 'signed' }
  | { readonly allowed: false; readonly why: string };

export const claVerdict = (input: {
  readonly author: string;
  readonly maintainers: readonly string[];
  /** The signatures on the base branch, before this pull request. */
  readonly before: readonly Signature[];
  /** The signatures with this pull request applied. */
  readonly after: readonly Signature[];
}): Verdict => {
  const author = input.author.toLowerCase();
  const known = new Set(input.before.map((signature) => signature.github.toLowerCase()));
  const added = input.after.filter((signature) => !known.has(signature.github.toLowerCase()));
  const forOthers = added.filter((signature) => signature.github.toLowerCase() !== author);
  if (forOthers.length > 0) {
    return {
      allowed: false,
      why: `it signs for somebody else (${forOthers.map((s) => s.github).join(', ')}): each person adds their own signature, in their own pull request`,
    };
  }
  const kept = new Set(input.after.map((signature) => signature.github.toLowerCase()));
  const removed = [...known].filter((login) => !kept.has(login));
  if (removed.length > 0) {
    return { allowed: false, why: `it removes a signature (${removed.join(', ')})` };
  }
  if (input.maintainers.some((login) => login.toLowerCase() === author)) {
    return { allowed: true, why: 'maintainer' };
  }
  if (BOTS.has(author)) return { allowed: true, why: 'bot' };
  const own = input.after.find((signature) => signature.github.toLowerCase() === author);
  if (own === undefined) {
    return {
      allowed: false,
      why: `${input.author} has not signed the contributor licence agreement: read CLA.md, and add yourself to .github/cla-signatures.json in this pull request`,
    };
  }
  if (own.version !== CLA_VERSION) {
    return {
      allowed: false,
      why: `${input.author} signed version ${own.version}; this is version ${CLA_VERSION}: sign it again`,
    };
  }
  return { allowed: true, why: 'signed' };
};
