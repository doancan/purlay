# @purlay/tokens

The visual vocabulary. **`tokens.json` is the source**; everything in `src/generated/` is derived from
it and checked against it (`bun run tokens:check`). What this is, why, and what was rejected:
`docs/DECISIONS.md` D-97.

## Changing a value

1. Edit `tokens.json`.
2. `bun run tokens:generate`. It refuses an unsound file (with every problem listed) and a pair of
   colours that is not readable in both themes (`src/pairs.ts` says which pairs and how much).
3. Commit the source and the generated files together.

A new **colour** needs a decision about contrast: add it to a pair in `pairs.ts`, or to `EXEMPT` with a
reason. A new **size** needs a binding in `src/emit.ts` (which Tailwind utilities it creates is a design
decision, not a guess from its name).

## The design system

The design system the seed came from (a claude.ai artifact) can read this file unchanged: every family is
`{ tokens: [{ name, value, usage }] }` and `type` keeps its `groups`/`styles` layout. This repository
owns the file. To update the design system, paste the file in; do not edit the two independently.

## Layers

| | |
|---|---|
| `src/schema.ts` | the shape |
| `src/model.ts` | soundness: grid, weights, motion, themes, aliases, names; reports every problem at once |
| `src/contrast.ts`, `src/pairs.ts`, `src/audit.ts` | readability, computed, and complete |
| `src/emit.ts`, `src/cli.ts` | the three generated files |
| `src/vocabulary.ts` | does the application speak only this vocabulary (used by `apps/web/src/styles.test.ts`) |
