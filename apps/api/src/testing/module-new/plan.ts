/**
 * What `bun run module:new` does, as data and pure functions (`docs/MODULE-GUIDE.md`): the files a module is made of, from
 * the templates beside this file, and the edits to files that exist, each at an anchor that must be found exactly once.
 * Nothing here reads the disk or the environment but `templateFiles`, so the editor is tested without a repository.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const MODULE_ID = /^[a-z][a-z0-9-]{0,31}$/;

export interface Names {
  /** `my-tasks`: the word an operator writes in `MODULES`, and the path. */
  readonly id: string;
  /** `MyTasks`. */
  readonly pascal: string;
  /** `myTasks`. */
  readonly camel: string;
  /** `my_tasks`: the table. */
  readonly snake: string;
  /** `MY_TASKS`. */
  readonly upper: string;
}

export interface Options {
  readonly requires: readonly string[];
  readonly optional: readonly string[];
  /** The number of the decision the module's skeleton is written under: the next one in `DECISIONS.md`. */
  readonly decision: number;
}

export const namesOf = (id: string): Names => {
  const words = id.split('-');
  const pascal = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join('');
  return {
    id,
    pascal,
    camel: pascal.charAt(0).toLowerCase() + pascal.slice(1),
    snake: words.join('_'),
    upper: words.join('_').toUpperCase(),
  };
};

/** Why `id` cannot be a new module's, or `undefined`. */
export const idProblem = (
  id: string,
  taken: ReadonlySet<string>,
  reserved: ReadonlySet<string>,
): string | undefined => {
  if (!MODULE_ID.test(id))
    return `"${id}" is not a module id: lowercase letters, digits and hyphens, starting with a letter, at most 32`;
  if (id.endsWith('-') || id.includes('--')) return `"${id}" has an empty word between its hyphens`;
  if (reserved.has(id)) return `"${id}" is a path the core owns`;
  if (taken.has(id)) return `"${id}" is already a module`;
  return undefined;
};

const sentence = (items: readonly string[]): string => items.map((item) => `'${item}'`).join(', ');

const cell = (items: readonly string[]): string =>
  items.length === 0 ? '—' : items.map((item) => `\`${item}\``).join(', ');

/** The words of the templates: `__NAME__`, replaced everywhere, in paths as in files. */
export const fill = (template: string, names: Names, options: Options): string => {
  const degrades = options.optional
    .map(
      (partner) =>
        `\n      ${partner}: 'Works without ${partner}; say here what a person sees instead.',`,
    )
    .join('');
  const tokens: Readonly<Record<string, string>> = {
    ID: names.id,
    PASCAL: names.pascal,
    CAMEL: names.camel,
    SNAKE: names.snake,
    UPPER: names.upper,
    REQUIRES_CELL: cell(options.requires),
    OPTIONAL_CELL: cell(options.optional),
    REQUIRES: sentence(options.requires),
    OPTIONAL: sentence(options.optional),
    SCENARIOS: options.optional
      .map(
        (partner) =>
          `  '${partner}': ({ runs }) => {
    if (runs('${partner}')) throw new Error('${partner} should be out of this world');
  },`,
      )
      .join('\n'),
    DECISION: String(options.decision),
    DEGRADES: degrades === '' ? '' : `${degrades}\n    `,
  };
  return template.replace(
    /__([A-Z]+(?:_[A-Z]+)*)__/g,
    (whole, token: string) => tokens[token] ?? whole,
  );
};

export interface NewFile {
  readonly path: string;
  readonly content: string;
}

const TEMPLATES = join(import.meta.dir, 'templates');

const walk = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)],
  );

/** The files of a new module: every template, its path and its text filled; `.optional.tpl` ones only when the module has an optional partner. */
export const templateFiles = (names: Names, options: Options): NewFile[] =>
  walk(TEMPLATES)
    .map((file) => ({ file, path: relative(TEMPLATES, file) }))
    .filter(({ path }) => options.optional.length > 0 || !path.endsWith('.optional.tpl'))
    .map(({ file, path }) => ({
      path: fill(path.replace(/(\.optional)?\.tpl$/, ''), names, options),
      content: fill(readFileSync(file, 'utf8'), names, options),
    }));

/** A change to a file that exists: `anchor` is replaced by `text`, which holds it again when the line stays; with no anchor, `text` ends the file. */
export interface Edit {
  readonly file: string;
  readonly anchor?: string;
  readonly text: string;
}

/** The file with the edit made; throws when the anchor is not found exactly once, so a moved line stops the run before it writes anything. */
export const applyEdit = (content: string, edit: Edit): string => {
  if (edit.anchor === undefined) return `${content.trimEnd()}\n${edit.text}`;
  const parts = content.split(edit.anchor);
  if (parts.length !== 2) {
    throw new Error(
      `${edit.file}: the anchor ${JSON.stringify(edit.anchor.slice(0, 60))} is not there exactly once, so nothing was written`,
    );
  }
  return `${parts[0] ?? ''}${edit.text}${parts[1] ?? ''}`;
};
