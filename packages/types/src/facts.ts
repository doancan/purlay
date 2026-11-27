/**
 * What a module tells the build happened, as a type with a payload (`MODULES.md` §4, D-283 §3).
 *
 * A fact carries the ids of what changed and a short label, never its state: whoever consumes it reads the state itself.
 * The declarations live here and not in a module's folder because a module binds to the contract and not to another module,
 * and the payload is a wire shape (`CONTRIBUTING.md` §1.4). A type is named `<owner>.<what>`, the owner being `core` or the
 * id of the module that publishes it, and a module's own are listed as `<ID>_FACTS` in its `<id>.ts`, declared with `defineFact` from
 * `fact-declaration.ts` (a file of its own, so that `<id>.ts` and this file, which joins its list, do not import one another).
 */
import type { TSchema } from '@sinclair/typebox';
import {
  FACT_HOLD_DAYS_MAX,
  FACT_SHAPE_FIRST,
  FACT_STRING_LENGTH_MAX,
  type FactDeclaration,
} from './fact-declaration';

/** The facts the core publishes. None yet: nothing in the core has a fact a module consumes. */
export const CORE_FACTS: readonly FactDeclaration[] = [];

/** Every fact type of the build: the core's and, as a module gets some, each module's `<ID>_FACTS`. */
export const FACTS: readonly FactDeclaration[] = [...CORE_FACTS];

const isHoldDays = (days: number): boolean =>
  Number.isInteger(days) && days >= 1 && days <= FACT_HOLD_DAYS_MAX;

/** The formats that bound a string by themselves: an id and a time. */
const BOUNDED_FORMATS: ReadonlySet<unknown> = new Set(['uuid', 'date-time']);

/** The JSON-schema keywords under which a schema holds other schemas, one or many. */
const NESTED = ['items', 'additionalProperties', 'not'] as const;
const NESTED_LISTS = ['anyOf', 'allOf', 'oneOf', 'prefixItems'] as const;
const NESTED_MAPS = ['properties', 'patternProperties'] as const;

/**
 * The paths of the strings of a schema that are not bounded to a short label: no `maxLength`, or one past `FACT_STRING_LENGTH_MAX`,
 * and no value or format that bounds them. Walks the JSON schema TypeBox makes, so a string in an object, an array, a union or a record counts.
 */
const unboundedStrings = (schema: unknown, path = ''): string[] => {
  if (typeof schema !== 'object' || schema === null) return [];
  const node = schema as Readonly<Record<string, unknown>>;
  const own =
    node['type'] === 'string' &&
    !('const' in node) &&
    !('enum' in node) &&
    !BOUNDED_FORMATS.has(node['format']) &&
    !(typeof node['maxLength'] === 'number' && node['maxLength'] <= FACT_STRING_LENGTH_MAX)
      ? [path === '' ? '/' : path]
      : [];
  const nested = [
    ...NESTED.flatMap((key) => unboundedStrings(node[key], `${path}/${key}`)),
    ...NESTED_LISTS.flatMap((key) => {
      const list = node[key];
      return Array.isArray(list)
        ? list.flatMap((one, at) => unboundedStrings(one, `${path}/${key}/${String(at)}`))
        : [];
    }),
    ...NESTED_MAPS.flatMap((key) => {
      const map = node[key];
      return typeof map === 'object' && map !== null
        ? Object.entries(map).flatMap(([name, one]) => unboundedStrings(one, `${path}/${name}`))
        : [];
    }),
  ];
  return [...own, ...nested];
};

/** What is wrong with a list of declarations: a type not named for its owner, an owner nobody is, a type declared twice, a hold for no days or for more than the outbox keeps, a string longer than a label. */
export const factOwnerProblems = (
  facts: readonly FactDeclaration[],
  moduleIds: readonly string[],
): string[] => {
  const seen = new Set<string>();
  return facts.flatMap(({ type, owner, absent, shape, reads, schema }) => {
    const problems: string[] = [];
    if (seen.has(type)) problems.push(`the fact "${type}" is declared twice`);
    seen.add(type);
    if (owner !== 'core' && !moduleIds.includes(owner)) {
      problems.push(
        `the fact "${type}" is owned by "${owner}", which is neither the core nor a module of this build`,
      );
    } else if (!type.startsWith(`${owner}.`)) {
      problems.push(
        `the fact "${type}" is owned by "${owner}", so it must be named "${owner}.<what>"`,
      );
    }
    if (typeof absent === 'object' && !isHoldDays(absent.holdDays)) {
      problems.push(
        `the fact "${type}" is held ${String(absent.holdDays)} days when its consumer is off: a whole number from 1 to ${String(FACT_HOLD_DAYS_MAX)}`,
      );
    }
    if (shape !== undefined && !(Number.isInteger(shape) && shape >= FACT_SHAPE_FIRST)) {
      problems.push(`the fact "${type}" has the shape ${String(shape)}: a whole number from 1`);
    }
    for (const earlier of Object.keys(reads ?? {}).map(Number)) {
      if (!(
        Number.isInteger(earlier) &&
        earlier >= FACT_SHAPE_FIRST &&
        earlier < (shape ?? FACT_SHAPE_FIRST)
      )) {
        problems.push(
          `the fact "${type}" reads the shape ${String(earlier)}, which is not an earlier shape than its own`,
        );
      }
    }
    const schemas: readonly (readonly [string, TSchema])[] = [
      ['', schema],
      ...Object.entries(reads ?? {}).map(
        ([earlier, reader]) => [` (shape ${earlier})`, reader.schema] as const,
      ),
    ];
    for (const [which, one] of schemas) {
      for (const at of unboundedStrings(one)) {
        problems.push(
          `the fact "${type}"${which} has a string at ${at} that may be longer than ${String(FACT_STRING_LENGTH_MAX)} characters: a fact carries ids and a short label, so give it a maxLength`,
        );
      }
    }
    return problems;
  });
};
