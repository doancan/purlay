/**
 * The address a link may carry, as a value nothing but the check can make (D-101 §2, §9).
 *
 * A link's address is the one attribute a renderer takes from a message, so it is the one place a
 * tree could carry something the page would act on. As a plain string, any code could build a link
 * node with any address and hand it to a renderer; the narrowing would have been the sanitiser only
 * by convention. As this class, the private constructor is reachable only through `SafeHref.of`,
 * which is the check, and the private field makes the type nominal: an object literal with an
 * `href`, or a spread of a real one, is not a `SafeHref` — a spread copies no private field. What a
 * type system cannot refuse, an assertion, lint refuses (`eslint.config.mjs`): by name everywhere,
 * and in this package any assertion at all, since a cast to a node that holds the address — an
 * `Inline` — skips the brand without naming it. The renderer (#43) is to check `instanceof` as well,
 * so a cast the lint rules do not see draws text, not a link.
 *
 * A class here, where D-54 chose a symbol key for a context: the symbol key survives a spread, and
 * a context's argument against a class — a value that must survive serialisation — does not apply to
 * a tree that is built where it is drawn and never sent.
 */

/** The only addresses a link may go to; anything else — relative, `//host`, `javascript:` — is its label's text. */
const SAFE_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:']);

export class SafeHref {
  readonly #href: string;

  private constructor(href: string) {
    this.#href = href;
    // Frozen, with its prototype and class below: a checked address cannot be redefined after the check.
    Object.freeze(this);
  }

  /**
   * The address, if a link may carry it. What is kept is the URL as the browser will read it
   * (`href`), not the characters that were typed, so the string that was checked is the string
   * that is rendered.
   */
  public static of(url: string): SafeHref | null {
    if (!URL.canParse(url)) return null;
    const parsed = new URL(url);
    return SAFE_PROTOCOLS.has(parsed.protocol) ? new SafeHref(parsed.href) : null;
  }

  public get href(): string {
    return this.#href;
  }
}

Object.freeze(SafeHref.prototype);
Object.freeze(SafeHref);
