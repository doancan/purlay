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
  /**
   * The files the attachments name, each at `blobs/<attachment id>` (and `<id>.thumbnail`): how many
   * were copied and their bytes; those gone since the snapshot — removed by retention, an erasure or a
   * delete — and those the store did not have although the row is still there, which is a fault.
   */
  blobs: Type.Object({
    count: Type.Integer({ minimum: 0 }),
    bytes: Type.Integer({ minimum: 0 }),
    removed: Type.Array(Type.String()),
    missing: Type.Array(Type.String()),
  }),
});
export type ExportManifest = Static<typeof ExportManifest>;
