/**
 * A workspace export's manifest (D-27 §3, D-140): a published format, read by whoever imports the
 * export somewhere else — so it is a contract like any other, and versioned. Written last, so an
 * export without one did not finish.
 */
import { Type, type Static } from '@sinclair/typebox';
import { ErrorCode } from './errors';

/** Bumped when a reader of the old shape would misread the new. */
export const EXPORT_FORMAT = 1;

/** What an export says of the files it copied: the same for a workspace's and a person's (D-241). */
const ExportBlobs = Type.Object({
  count: Type.Integer({ minimum: 0 }),
  bytes: Type.Integer({ minimum: 0 }),
  removed: Type.Array(Type.String()),
  missing: Type.Array(Type.String()),
});

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
  blobs: ExportBlobs,
});
export type ExportManifest = Static<typeof ExportManifest>;

/**
 * A person's export of their own data (D-241): the same format as a workspace's — one NDJSON file per
 * table, the files at `blobs/`, this manifest last — about one person, across every workspace.
 */
export const PersonalExportManifest = Type.Object({
  format: Type.Literal(EXPORT_FORMAT),
  exportedAt: Type.String({ format: 'date-time' }),
  person: Type.Object({ id: Type.String(), username: Type.String() }),
  schema: Type.String(),
  scope: Type.Literal('person'),
  tables: Type.Record(Type.String(), Type.Integer({ minimum: 0 })),
  /** The files the person uploaded with the messages in the export, said as a workspace export's are. */
  blobs: ExportBlobs,
});
export type PersonalExportManifest = Static<typeof PersonalExportManifest>;

/** Where an owner's export stands (D-140): being made, ready to download once, or done with. */
export const ExportStatus = Type.Union([
  Type.Literal('pending'),
  Type.Literal('ready'),
  Type.Literal('failed'),
  Type.Literal('downloaded'),
  Type.Literal('expired'),
]);
export type ExportStatus = Static<typeof ExportStatus>;

/**
 * Why an export failed: a refusal the contract already names (a store not configured, say), or one of
 * the export's own — it could not be made, its making was cut off by a restart, or the owner who asked
 * is no longer one when it started.
 */
export const ExportFailure = Type.Union([
  ErrorCode,
  Type.Literal('EXPORT_FAILED'),
  Type.Literal('EXPORT_ABANDONED'),
  Type.Literal('EXPORT_REQUESTER_GONE'),
]);
export type ExportFailure = Static<typeof ExportFailure>;

/**
 * `POST` and `GET /api/workspaces/:workspaceId/exports` — an owner's export, as they see it: never where
 * the archive is kept. `sizeBytes` and `expiresAt` once it is ready; `failure` a code, once it failed.
 * A person's export of their own data has the same shape, at `/api/me/exports` (D-241).
 */
export const WorkspaceExport = Type.Object({
  id: Type.String({ format: 'uuid' }),
  status: ExportStatus,
  createdAt: Type.String({ format: 'date-time' }),
  finishedAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  expiresAt: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
  sizeBytes: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  failure: Type.Union([ExportFailure, Type.Null()]),
});
export type WorkspaceExport = Static<typeof WorkspaceExport>;

/** How long a ready export waits to be downloaded before it is thrown away (D-140). */
export const EXPORT_KEPT_HOURS = 24;

/**
 * How many exports of their own data a person may ask for in any 24 hours (D-241): each reads everything
 * they ever wrote, and three leaves room for one that failed and one asked again.
 */
export const PERSONAL_EXPORTS_PER_DAY = 3;
