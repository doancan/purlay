/**
 * A workspace export's manifest (D-27 §3, D-140): a published format, read by whoever imports the
 * export somewhere else — so it is a contract like any other, and versioned. Written last, so an
 * export without one did not finish.
 */
import { Type, type Static } from '@sinclair/typebox';

/** Bumped when a reader of the old shape would misread the new. */
export const EXPORT_FORMAT = 1;

export const ExportManifest = Type.Object({
  format: Type.Literal(EXPORT_FORMAT),
  exportedAt: Type.String({ format: 'date-time' }),
  workspace: Type.Object({ id: Type.String(), slug: Type.String(), name: Type.String() }),
  /** The last migration the database had: the shape every row was in. */
  schema: Type.String(),
  /** Every channel (`all`, the operator's), or those the owner who asked could see. */
  scope: Type.Union([Type.Literal('all'), Type.Literal('visible-to-owner')]),
  /** Rows written, by table — one file each, `<table>.ndjson`. */
  tables: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
});
export type ExportManifest = Static<typeof ExportManifest>;
