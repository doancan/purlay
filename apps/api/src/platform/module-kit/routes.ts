/**
 * Which paths a module owns (`MODULES.md` §3, D-250).
 *
 * A template is a path whose segments are literal, `:name` (any one segment) or, last, `**` (the rest, one segment
 * or more below the prefix). Pure: it reads no request and opens nothing, so the check that a disabled module's
 * route is a `404` is a function of a path.
 */
const segments = (path: string): string[] => path.split('/').filter((segment) => segment !== '');

const matches = (template: readonly string[], path: readonly string[]): boolean => {
  for (const [index, wanted] of template.entries()) {
    if (wanted === '**') return path.length > index;
    const given = path[index];
    if (given === undefined) return false;
    if (!wanted.startsWith(':') && wanted !== given) return false;
  }
  return template.length === path.length;
};

/** A test for a path against any of the templates. */
export const ownsPath = (templates: readonly string[]): ((path: string) => boolean) => {
  const compiled = templates.map(segments);
  return (path) => {
    const given = segments(path);
    return compiled.some((template) => matches(template, given));
  };
};

/**
 * Whether some path is matched by both templates (a subtree and a template inside it, two templates that differ only
 * where one has a name), by the same rules as `ownsPath`. A literal template that is only the prefix of another matches
 * a different path and does not overlap it.
 */
export const templatesOverlap = (first: string, second: string): boolean => {
  const left = segments(first);
  const right = segments(second);
  for (let index = 0; ; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === '**' && b === '**') return true;
    // A subtree takes any path with a segment here, so the other must have one.
    if (a === '**') return b !== undefined;
    if (b === '**') return a !== undefined;
    if (a === undefined || b === undefined) return a === b;
    if (!a.startsWith(':') && !b.startsWith(':') && a !== b) return false;
  }
};
