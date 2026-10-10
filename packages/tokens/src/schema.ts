/**
 * The shape of `tokens.json`, and nothing else about it.
 *
 * This is the structure only: a name is a string of the right form, a family is a
 * list. What a value *means* — that a colour resolves, that a spacing step sits on
 * the 4px grid, that a pair of colours is readable — is `model.ts`'s to judge,
 * because a schema can say "a string" and cannot say "a string that is a colour in
 * every theme".
 *
 * **The file stays loadable by the design system it came from.** Every family is
 * `{ tokens: [{ name, value, usage }] }` and `type` keeps its `groups`/`styles`
 * layout, so the same file can be handed back to the design tool unchanged
 * (`docs/DECISIONS.md` D-97). Strictness is ours: unknown keys are refused rather
 * than carried, because a family nobody generates anything from is a family that
 * silently does nothing.
 */
import { Type, type Static } from '@sinclair/typebox';

/** Lower-case kebab: it becomes a CSS custom property, a Tailwind class and a TypeScript literal. */
const TOKEN_NAME = '^[a-z][a-z0-9]*(-[a-z0-9]+)*$';

const Name = Type.String({ pattern: TOKEN_NAME, maxLength: 64 });
const Usage = Type.String({ minLength: 1, maxLength: 1000 });
const Note = Type.Optional(Type.String({ minLength: 1, maxLength: 400 }));

/** A value per theme, or one string that applies to every theme (an alias, or a shadow shared by both). */
const Themed = Type.Union([
  Type.String({ minLength: 1 }),
  Type.Record(Type.String(), Type.String()),
]);

const Token = Type.Object(
  { name: Name, value: Type.String({ minLength: 1 }), usage: Usage },
  { additionalProperties: false },
);

const ThemedToken = Type.Object(
  { name: Name, value: Themed, usage: Usage },
  { additionalProperties: false },
);

const PlainFamily = Type.Object(
  { note: Note, tokens: Type.Array(Token, { minItems: 1 }) },
  { additionalProperties: false },
);

const ThemedFamily = Type.Object(
  { note: Note, tokens: Type.Array(ThemedToken, { minItems: 1 }) },
  { additionalProperties: false },
);

const TextStyle = Type.Object(
  {
    name: Name,
    fontSize: Type.String({ minLength: 1 }),
    lineHeight: Type.Number(),
    fontWeight: Type.Integer(),
    letterSpacing: Type.Optional(Type.String({ minLength: 1 })),
    usage: Usage,
    sample: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);

export const TokensFile = Type.Object(
  {
    name: Type.String({ minLength: 1 }),
    version: Type.Integer({ minimum: 1 }),
    meta: Type.Object({ source: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    color: Type.Object(
      {
        themes: Type.Array(
          Type.Object(
            { id: Name, name: Type.String({ minLength: 1 }) },
            { additionalProperties: false },
          ),
          { minItems: 1, maxItems: 8 },
        ),
        tokens: Type.Array(ThemedToken, { minItems: 1 }),
      },
      { additionalProperties: false },
    ),
    type: Type.Object(
      {
        // Self-hosted faces, one entry per file (D-100). No third party is ever asked for a font
        // (D-39): `file` is a path under the web app's own `public/`, never a URL, so the origin
        // that serves the page serves the face and the CSP needs no new source.
        fonts: Type.Array(
          Type.Object(
            {
              family: Type.String({ minLength: 1, maxLength: 64 }),
              weight: Type.Union([
                Type.Literal('400'),
                Type.Literal('500'),
                Type.Literal('600'),
                Type.Literal('700'),
              ]),
              file: Type.String({ pattern: '^fonts/[a-z0-9-]+\\.woff2$' }),
              range: Type.Union([Type.Literal('latin'), Type.Literal('latin-ext')]),
            },
            { additionalProperties: false },
          ),
          { maxItems: 24 },
        ),
        families: Type.Object(
          { sans: Type.String({ minLength: 1 }), mono: Type.String({ minLength: 1 }) },
          { additionalProperties: false },
        ),
        groups: Type.Array(
          Type.Object(
            {
              name: Type.String({ minLength: 1 }),
              family: Type.Union([Type.Literal('sans'), Type.Literal('mono')]),
              styles: Type.Array(TextStyle, { minItems: 1 }),
            },
            { additionalProperties: false },
          ),
          { minItems: 1 },
        ),
      },
      { additionalProperties: false },
    ),
    spacing: PlainFamily,
    radius: PlainFamily,
    shadow: ThemedFamily,
    size: PlainFamily,
    zIndex: PlainFamily,
    borderWidth: PlainFamily,
    duration: PlainFamily,
    easing: PlainFamily,
  },
  { additionalProperties: false },
);

export type TokensFile = Static<typeof TokensFile>;
