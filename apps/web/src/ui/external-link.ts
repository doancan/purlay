/**
 * What makes a link leave the product safely: a new tab that cannot reach back through `window.opener` and is not
 * told where it came from. Spread onto an anchor (`<a href={…} {...EXTERNAL_LINK}>`); the same two attributes were
 * written out by hand at some twenty sites, three of them with a different `rel`.
 */
export const EXTERNAL_LINK = { target: '_blank', rel: 'noopener noreferrer' } as const;
